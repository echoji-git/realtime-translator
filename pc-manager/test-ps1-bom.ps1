# pc-manager 안의 모든 .ps1 이 UTF-8 BOM 으로 시작하는지 확인한다.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$files = @(Get-ChildItem -Path $root -Filter *.ps1 -Recurse -File)
if ($files.Count -lt 1) { throw "ps1 파일이 없습니다." }
$bad = New-Object System.Collections.Generic.List[string]
foreach ($file in $files) {
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    if (-not $hasBom) {
        $bad.Add($file.FullName) | Out-Null
    }
}
if ($bad.Count -gt 0) {
    throw ("UTF-8 BOM 이 없는 ps1: " + ($bad -join ", "))
}
Write-Output ("ps1 bom tests ok " + $files.Count)
