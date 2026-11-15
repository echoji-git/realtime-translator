# 제외 범위 판정만 확인한다. Pester와 Windows 관리자 권한은 쓰지 않는다.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "port-range.ps1")

function Assert-True {
    param($Cond, [string]$Message)
    if (-not $Cond) { throw $Message }
}

function Assert-Equal {
    param($Actual, $Expected, [string]$Message)
    if ($Actual -ne $Expected) { throw "$Message : 실제 $Actual , 기대 $Expected" }
}

Assert-True (Test-PortInRange -Port 11434 -Start 11353 -End 11452) "11434는 11353-11452 안에 있다"
Assert-True (Test-PortInRange -Port 11353 -Start 11353 -End 11452) "시작 경계"
Assert-True (Test-PortInRange -Port 11452 -Start 11353 -End 11452) "끝 경계"
Assert-True (-not (Test-PortInRange -Port 11453 -Start 11353 -End 11452)) "끝 바로 밖"
Assert-True (-not (Test-PortInRange -Port 8091 -Start 11353 -End 11452)) "8091은 그 범위 밖"
Assert-True (-not (Test-PortInRange -Port 8092 -Start 11353 -End 11452)) "8092는 그 범위 밖"
Assert-True (Test-PortInRange -Port 11434 -Start 11452 -End 11353) "시작과 끝이 뒤집혀도 같은 범위"

$english = @"
Protocol tcp Port Exclusion Ranges

Start Port    End Port
----------    --------
     11353       11452
     50000       50059     *

* - Administered port exclusions.
"@
$ranges = @(ConvertFrom-ExcludedPortText -Text $english)
Assert-Equal $ranges.Count 2 "영문 출력에서 범위 두 개"
$hits = @(Get-BlockedPorts -Ports @(11434, 8091, 8092) -Ranges $ranges)
Assert-Equal $hits.Count 1 "11434만 막힘"
Assert-Equal $hits[0].Port 11434 "막힌 포트"
Assert-Equal $hits[0].Start 11353 "범위 시작"
Assert-Equal $hits[0].End 11452 "범위 끝"

$korean = @"
프로토콜 tcp 포트 제외 범위

시작 포트    끝 포트
----------    --------
      8090        8092

"@
$koreanRanges = @(ConvertFrom-ExcludedPortText -Text $korean)
$koreanHits = @(Get-BlockedPorts -Ports @(11434, 8091, 8092) -Ranges $koreanRanges)
Assert-Equal $koreanHits.Count 2 "8091과 8092가 막힘"
Assert-Equal $koreanHits[0].Port 8091 "첫 막힌 포트"
Assert-Equal $koreanHits[1].Port 8092 "둘째 막힌 포트"
Assert-Equal $koreanHits[0].Start 8090 "한글 출력 시작"
Assert-Equal $koreanHits[1].End 8092 "한글 출력 끝"

$clear = @(Get-BlockedPorts -Ports @(11434, 8091, 8092) -Ranges @())
Assert-Equal $clear.Count 0 "범위가 없으면 막힌 포트 없음"
$outside = @(Get-BlockedPorts -Ports @(11434, 8091, 8092) -Ranges @([pscustomobject]@{ Start = 12000; End = 12010 }))
Assert-Equal $outside.Count 0 "세 포트가 다른 범위에 없음"

Write-Output "port-range tests ok"
