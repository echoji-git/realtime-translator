$ErrorActionPreference = "Stop"
$Root = "C:\rtb-pc-api"
$Flag = Join-Path $Root "enabled.flag"
$Lock = Join-Path $Root "run\busy.lock"
New-Item -ItemType Directory -Force -Path (Join-Path $Root "run") | Out-Null

if (Test-Path $Lock) {
    $age = (Get-Date) - (Get-Item $Lock).LastWriteTime
    if ($age.TotalMinutes -lt 3) {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show("아직 이전 켜기 또는 끄기가 끝나지 않았습니다.", "번역 PC")
        exit 0
    }
}
Set-Content -Path $Lock -Value (Get-Date -Format o) -Encoding ascii
try {
    if (Test-Path $Flag) {
        Remove-Item $Flag -Force
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "stop.ps1")
    } else {
        Set-Content -Path $Flag -Value "on" -Encoding ascii
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "start.ps1")
        if ($LASTEXITCODE -ne 0) { Remove-Item $Flag -Force -ErrorAction SilentlyContinue }
    }
} finally {
    Remove-Item $Lock -Force -ErrorAction SilentlyContinue
}
