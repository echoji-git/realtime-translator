# v1.033 PC 매니저 설치. 관리자 권한은 필요 없습니다.
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = "C:\rtb-pc-api"
$Desktop = [Environment]::GetFolderPath("Desktop")
New-Item -ItemType Directory -Force -Path $Root, (Join-Path $Root "logs"), (Join-Path $Root "run") | Out-Null

$Backup = Join-Path $Root "backup-v1032"
New-Item -ItemType Directory -Force -Path $Backup | Out-Null
foreach ($name in @("start.ps1", "stop.ps1", "toggle.ps1", "install-task.ps1", "door.py")) {
    $src = Join-Path $Root $name
    $dst = Join-Path $Backup $name
    if ((Test-Path $src) -and -not (Test-Path $dst)) {
        Copy-Item $src $dst -Force
    }
}

$LegacyDest = Join-Path $Root "legacy-v1032"
New-Item -ItemType Directory -Force -Path $LegacyDest | Out-Null
$LegacySrc = Join-Path $Here "legacy"
if (Test-Path $LegacySrc) {
    Copy-Item (Join-Path $LegacySrc "*") $LegacyDest -Force
}

foreach ($name in @("manager.py", "start.ps1", "stop.ps1", "toggle.ps1", "install-task.ps1", "uninstall.ps1")) {
    Copy-Item (Join-Path $Here $name) (Join-Path $Root $name) -Force
}

# 옛 door 가 떠 있으면 끈 뒤 매니저로 다시 켠다.
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and (
        $_.CommandLine -like "*C:\rtb-pc-api\door.py*" -or
        $_.CommandLine -like "*C:\rtb-pc-api\manager.py*"
    )
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

$KeyFile = Join-Path $Root "manager-key.txt"
$KeyNote = Join-Path $Desktop "번역PC-비밀키.txt"
if (-not (Test-Path $KeyFile)) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $key = [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    Set-Content -Path $KeyFile -Value $key -Encoding ascii -NoNewline
    try {
        icacls $KeyFile /inheritance:r | Out-Null
        icacls $KeyFile /grant:r "${env:USERNAME}:(R,W)" | Out-Null
    } catch {
    }
    $note = @"
실시간 번역 PC 비밀 키 (v1.033)

이 키는 설치할 때 한 번만 보여 줍니다. 번역 페이지 설정의 비밀 키 칸에 붙여 넣으세요.
페이지: https://echoji-git.github.io/realtime-translator/translator.html

$key

PC에 보관된 파일: $KeyFile
키를 바꾸려면 이 파일과 위의 파일을 지운 뒤 install.ps1 을 다시 실행하세요.
"@
    Set-Content -Path $KeyNote -Value $note -Encoding UTF8
    try { Set-Clipboard -Value $key } catch { }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show("비밀 키를 클립보드와 바탕화면 번역PC-비밀키.txt 에 넣었습니다.`r`n`r`n$key`r`n`r`n번역 페이지 설정의 비밀 키 칸에 붙여 넣으세요.", "번역 PC")
} else {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show("이미 비밀 키가 있어 그대로 둡니다.`r`n바탕화면의 번역PC-비밀키.txt 또는 $KeyFile 을 확인하세요.`r`n새 키가 필요하면 그 파일들을 지운 뒤 다시 설치하세요.", "번역 PC")
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "install-task.ps1")
if ($LASTEXITCODE -ne 0) { throw "예약 작업을 등록하지 못했습니다." }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "start.ps1")
if ($LASTEXITCODE -ne 0) { throw "매니저를 켜지 못했습니다. 로그는 C:\rtb-pc-api\logs 입니다." }

Write-Output "INSTALL_OK"
Write-Output $KeyFile
