# v1.033 을 옛 door.py 방식으로 되돌립니다.
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\rtb-pc-api\uninstall.ps1
$ErrorActionPreference = "Continue"
$Root = "C:\rtb-pc-api"
$RunDir = Join-Path $Root "run"

Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and (
        $_.CommandLine -like "*C:\rtb-pc-api\manager.py*" -or
        $_.CommandLine -like "*C:\rtb-pc-api\door.py*" -or
        $_.CommandLine -like "*C:\rtb-pc-api\faster_whisper_server.py*" -or
        $_.CommandLine -like "*C:\rtb-pc-api\ggml-*" -or
        ($_.CommandLine -like "*whisper-server.exe*" -and $_.CommandLine -like "*8091*") -or
        ($_.CommandLine -like "*cloudflared*" -and $_.CommandLine -like "*127.0.0.1:8092*")
    )
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

$tailscale = "C:\Program Files\Tailscale\tailscale.exe"
if (Test-Path $tailscale) {
    & $tailscale funnel --https=443 off *> $null
}

function Restore-One([string]$name) {
    $backup = Join-Path $Root ("backup-v1032\" + $name)
    $legacy = Join-Path $Root ("legacy-v1032\" + $name)
    $dest = Join-Path $Root $name
    if (Test-Path $backup) {
        Copy-Item $backup $dest -Force
        return
    }
    if (Test-Path $legacy) {
        Copy-Item $legacy $dest -Force
    }
}

foreach ($name in @("start.ps1", "stop.ps1", "toggle.ps1", "install-task.ps1", "door.py")) {
    Restore-One $name
}

Remove-Item (Join-Path $RunDir "manager.pid") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $RunDir "stt.pid") -Force -ErrorAction SilentlyContinue

$exe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
if (Test-Path (Join-Path $Root "start.ps1")) {
    try {
        $action = New-ScheduledTaskAction -Execute $exe -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\rtb-pc-api\start.ps1"' -WorkingDirectory "C:\rtb-pc-api"
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $trigger.Delay = "PT20S"
        $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName "RtbPcApi" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    } catch {
    }
}

Add-Type -AssemblyName System.Windows.Forms
[void][System.Windows.Forms.MessageBox]::Show("옛 door.py 방식으로 되돌렸습니다.`r`n지금은 꺼져 있습니다. 다시 켜려면 바탕화면의 번역PC 켜기끄기를 누르세요.`r`n`r`n키 검사는 없습니다. 인터넷에 열린 주소는 키 없이 다시 쓸 수 있으니, 필요할 때만 켜세요.", "번역 PC")
Write-Output "UNINSTALL_OK"
