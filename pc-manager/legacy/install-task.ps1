$desktop = [Environment]::GetFolderPath("Desktop")
$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut((Join-Path $desktop "번역PC 켜기끄기.lnk"))
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "C:\rtb-pc-api\toggle.ps1"'
$s.WorkingDirectory = "C:\rtb-pc-api"
$s.WindowStyle = 7
$s.Description = "GitHub 번역 페이지가 이 PC의 Whisper와 Gemma를 쓰게 켜거나 끕니다."
$s.Save()
Set-Content -Path "C:\rtb-pc-api\enabled.flag" -Value "on" -Encoding ascii
$exe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$action = New-ScheduledTaskAction -Execute $exe -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\rtb-pc-api\start.ps1"' -WorkingDirectory "C:\rtb-pc-api"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT20S"
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "RtbPcApi" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Output "TASK_OK"
Write-Output (Test-Path (Join-Path $desktop "번역PC 켜기끄기.lnk"))
Get-ScheduledTask -TaskName "RtbPcApi" | Select-Object TaskName, State | Format-List
