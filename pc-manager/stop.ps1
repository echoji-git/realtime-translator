﻿$ErrorActionPreference = "Continue"
$Root = "C:\rtb-pc-api"
$RunDir = Join-Path $Root "run"
$Desktop = [Environment]::GetFolderPath("Desktop")
$UrlFile = Join-Path $Desktop "번역PC-주소.txt"

Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and (
        $_.CommandLine -like "*C:\rtb-pc-api\door.py*" -or
        $_.CommandLine -like "*C:\rtb-pc-api\manager.py*" -or
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

Remove-Item (Join-Path $RunDir "url.txt") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $RunDir "whisper.pid") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $RunDir "door.pid") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $RunDir "manager.pid") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $RunDir "stt.pid") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $RunDir "cloudflared.pid") -Force -ErrorAction SilentlyContinue

$note = @"
꺼져 있음

GitHub 번역 페이지는 이 PC의 받아쓰기와 번역을 부르지 않습니다.
Tailscale 연결은 유지되고, Funnel만 꺼집니다.
다시 켜려면 바탕화면의 "번역PC 켜기끄기"를 누르세요.
"@
Set-Content -Path $UrlFile -Value $note -Encoding UTF8

Add-Type -AssemblyName System.Windows.Forms
[void][System.Windows.Forms.MessageBox]::Show("꺼 두었습니다. 다음 로그인 때는 켜지지 않습니다.`r`n다시 켜려면 같은 아이콘을 누르세요.", "번역 PC")
