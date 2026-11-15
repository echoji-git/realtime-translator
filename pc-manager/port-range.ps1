# Windows가 잡아 둔 TCP 제외 범위에 서비스 포트가 들어 있는지 판정한다.
# netsh 출력 문자열만 받으므로 시험할 때 네트워크나 관리자 권한이 필요 없다.

function Test-PortInRange {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][int]$Start,
        [Parameter(Mandatory = $true)][int]$End
    )
    if ($End -lt $Start) {
        $swap = $Start
        $Start = $End
        $End = $swap
    }
    return ($Port -ge $Start -and $Port -le $End)
}

function ConvertFrom-ExcludedPortText {
    param([string]$Text)
    $ranges = New-Object System.Collections.Generic.List[object]
    if (-not $Text) { return @() }
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\s*(\d+)\s+(\d+)\b') {
            $ranges.Add([pscustomobject]@{
                Start = [int]$Matches[1]
                End = [int]$Matches[2]
            }) | Out-Null
        }
    }
    return @($ranges.ToArray())
}

function Get-BlockedPorts {
    param(
        [int[]]$Ports,
        [object[]]$Ranges
    )
    $hits = New-Object System.Collections.Generic.List[object]
    if (-not $Ports -or -not $Ranges) { return @() }
    foreach ($port in $Ports) {
        foreach ($range in $Ranges) {
            if ($null -eq $range) { continue }
            $start = [int]$range.Start
            $end = [int]$range.End
            if (Test-PortInRange -Port ([int]$port) -Start $start -End $end) {
                $hits.Add([pscustomobject]@{
                    Port = [int]$port
                    Start = $start
                    End = $end
                }) | Out-Null
            }
        }
    }
    return @($hits.ToArray())
}
