param([switch]$Quiet)
$ErrorActionPreference = "Stop"
$Root = "C:\rtb-pc-api"
$Flag = Join-Path $Root "enabled.flag"
$LogDir = Join-Path $Root "logs"
$RunDir = Join-Path $Root "run"
$Desktop = [Environment]::GetFolderPath("Desktop")
$UrlFile = Join-Path $Desktop "번역PC-주소.txt"
$StateUrl = Join-Path $RunDir "url.txt"
$KeyFile = Join-Path $Root "manager-key.txt"
$TrModel = "gemma3:1b"
$PcEngine = "whisper"
$PcSize = "base"
$PortRangeFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "port-range.ps1"
if (-not (Test-Path $PortRangeFile)) { throw "port-range.ps1 이 없습니다." }
. $PortRangeFile

function Read-PcState {
    $path = Join-Path $Root "manager-state.json"
    if (-not (Test-Path $path)) { return }
    try {
        $data = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return
    }
    if ($data.engine -eq "whisper" -or $data.engine -eq "sensevoice") { $script:PcEngine = [string]$data.engine }
    if ($data.size -eq "base" -or $data.size -eq "small" -or $data.size -eq "turbo") { $script:PcSize = [string]$data.size }
    if ($data.model -eq "gemma3:1b" -or $data.model -eq "gemma2:2b" -or $data.model -eq "gemma3:4b") { $script:TrModel = [string]$data.model }
}

function Get-SttFile([string]$size) {
    if ($size -eq "small") { return Join-Path $Root "ggml-small.bin" }
    if ($size -eq "turbo") { return Join-Path $Root "ggml-large-v3-turbo.bin" }
    return Join-Path $Root "ggml-base.bin"
}

if (-not (Test-Path $Flag)) { exit 0 }
New-Item -ItemType Directory -Force -Path $LogDir, $RunDir | Out-Null

[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "https://echoji-git.github.io", "User")
[Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE", "30m", "User")
$env:OLLAMA_ORIGINS = "https://echoji-git.github.io"
$env:OLLAMA_KEEP_ALIVE = "30m"
if (Test-Path Env:OLLAMA_HOST) { Remove-Item Env:OLLAMA_HOST }

function Show-Note([string]$text) {
    if ($Quiet) {
        Write-Output $text
        return
    }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($text, "번역 PC")
}

function Read-Shared([string]$path) {
    if (-not (Test-Path $path)) { return "" }
    $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $sr = New-Object System.IO.StreamReader($fs)
        return $sr.ReadToEnd()
    } finally {
        $sr.Dispose()
        $fs.Dispose()
    }
}

function Test-Listen([int]$port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $wait = $client.BeginConnect("127.0.0.1", $port, $null, $null)
        $ok = $wait.AsyncWaitHandle.WaitOne(400, $false)
        if (-not $ok) { return $false }
        $client.EndConnect($wait)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Wait-Listen([int]$port, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Listen $port) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

function Stop-Matching([scriptblock]$test) {
    Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and (& $test $_.CommandLine)
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Stop-Stt {
    Stop-Matching {
        param($line)
        $line -like "*C:\rtb-pc-api\faster_whisper_server.py*" -or
        $line -like "*C:\rtb-pc-api\ggml-*" -or
        ($line -like "*whisper-server.exe*" -and $line -like "*8091*")
    }
}

function Stop-Door {
    Stop-Matching {
        param($line)
        $line -like "*C:\rtb-pc-api\door.py*" -or $line -like "*C:\rtb-pc-api\manager.py*"
    }
}

function Stop-Tunnel {
    Stop-Matching {
        param($line)
        $line -like "*cloudflared*" -and $line -like "*127.0.0.1:8092*"
    }
}

function Stop-Funnel {
    $tailscale = "C:\Program Files\Tailscale\tailscale.exe"
    if (-not (Test-Path $tailscale)) { return }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $tailscale funnel --https=443 off *> $null
    } catch {
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Stop-OurStack {
    Stop-Stt
    Stop-Door
    Stop-Tunnel
    Stop-Funnel
    Start-Sleep -Seconds 1
}

function Test-WhisperBase {
    $procs = @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and $_.CommandLine -like "*C:\rtb-pc-api\ggml-base.bin*" -and $_.CommandLine -like "*8091*"
    })
    return ($procs.Count -gt 0) -and (Test-Listen 8091)
}

function Unload-OtherModels([string]$Keep) {
    $ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (-not (Test-Path $ollama)) { return }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        foreach ($name in @("gemma3:1b", "gemma2:2b", "gemma3:4b")) {
            if ($name -ne $Keep) { & $ollama stop $name *> $null }
        }
    } catch {
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Invoke-Tailscale {
    param([string[]]$ArgList)
    $tailscale = "C:\Program Files\Tailscale\tailscale.exe"
    if (-not (Test-Path $tailscale)) { throw "Tailscale이 설치되어 있지 않습니다." }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        return (& $tailscale @ArgList 2>&1 | Out-String)
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Ensure-Tailscale {
    $svc = Get-Service Tailscale -ErrorAction SilentlyContinue
    if (-not $svc) { throw "Tailscale 서비스가 없습니다." }
    if ($svc.Status -ne "Running") { Start-Service Tailscale }
    $deadline = (Get-Date).AddSeconds(45)
    do {
        $text = Invoke-Tailscale @("status")
        if ($text -match "100\.\d+\.\d+\.\d+") { return }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    throw "Tailscale이 테일넷에 붙지 않았습니다."
}

function Get-FunnelUrl {
    $raw = Invoke-Tailscale @("status", "--json")
    $start = $raw.IndexOf("{")
    if ($start -lt 0) { return "" }
    $data = $raw.Substring($start) | ConvertFrom-Json
    $name = ([string]$data.Self.DNSName).Trim().TrimEnd(".")
    if (-not $name) { return "" }
    return "https://$name"
}

function Test-FunnelUp {
    $text = Invoke-Tailscale @("funnel", "status")
    return $text -match "proxy http://127\.0\.0\.1:8092"
}

function Start-Funnel {
    $out = Invoke-Tailscale @("funnel", "--bg", "--yes", "8092")
    if ($out -match "Funnel is not enabled") { throw "Tailscale Funnel이 테일넷에서 꺼져 있습니다." }
    $deadline = (Get-Date).AddSeconds(25)
    do {
        if (Test-FunnelUp) { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Tailscale Funnel이 8092로 열리지 않았습니다."
}

function Test-OllamaOrigin {
    param([int]$Seconds = 20)
    if (-not (Test-Listen 11434)) { return "down" }
    $headerFile = Join-Path $LogDir "ollama-cors.txt"
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        & curl.exe -s -D $headerFile -o NUL --noproxy "*" -X OPTIONS --max-time 5 -H "Origin: https://echoji-git.github.io" -H "Access-Control-Request-Method: POST" "http://127.0.0.1:11434/api/tags" | Out-Null
        if (Test-Path $headerFile) {
            $text = Get-Content $headerFile -Raw -ErrorAction SilentlyContinue
            if ($text -match "(?i)access-control-allow-origin:\s*https://echoji-git\.github\.io") { return "ok" }
            if ($text -match "(?i)^HTTP/") { return "rejected" }
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    return "silent"
}

function Start-OllamaServer {
    $ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (-not (Test-Path $ollama)) { throw "Ollama 실행 파일이 없습니다." }
    Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath -like "*\Programs\Ollama\*"
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    $out = Join-Path $LogDir "ollama.log"
    $err = Join-Path $LogDir "ollama.err.log"
    Start-Process -FilePath $ollama -ArgumentList @("serve") -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null
    if (-not (Wait-Listen 11434 45)) { throw "Ollama가 127.0.0.1:11434 에서 응답하지 않습니다." }
    $origin = Test-OllamaOrigin -Seconds 300
    if ($origin -eq "ok") { return }
    if ($origin -eq "rejected") { throw "Ollama가 GitHub 페이지 출처를 허용하지 않습니다." }
    throw "Ollama가 포트는 열었지만 아직 응답하지 않습니다. 그래픽카드 확인이 길어졌습니다."
}

function Start-Logged([string]$name, [string]$file, [string[]]$argList, [string]$work) {
    $out = Join-Path $LogDir "$name.log"
    $err = Join-Path $LogDir "$name.err.log"
    foreach ($path in @($out, $err)) {
        if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
    }
    $proc = Start-Process -FilePath $file -ArgumentList $argList -WorkingDirectory $work -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    Set-Content -Path (Join-Path $RunDir "$name.pid") -Value $proc.Id -Encoding ascii
    return $proc
}

function Find-WhisperExe {
    $found = Get-ChildItem -Path (Join-Path $Root "whisper") -Filter "whisper-server.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $found) { throw "whisper-server.exe 가 없습니다." }
    return $found
}

function Wait-TunnelUrl([int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        $text = (Read-Shared (Join-Path $LogDir "cloudflared.log")) + (Read-Shared (Join-Path $LogDir "cloudflared.err.log"))
        if ($text -match "https://[a-z0-9-]+\.trycloudflare\.com") { return $Matches[0] }
        Start-Sleep -Milliseconds 500
    }
    return ""
}

function Write-UrlNote([string]$url) {
    Set-Content -Path $StateUrl -Value $url -Encoding ascii
    $note = @"
켜져 있음

PC API 주소:
$url

비밀 키 파일:
$KeyFile

번역 페이지
https://echoji-git.github.io/realtime-translator/translator.html

페이지 설정에서 PC API를 고르고, 이 주소와 비밀 키를 넣은 뒤 저장하세요.
받아쓰기와 번역 모델은 페이지의 적용 버튼이 이 PC에 전달합니다.
키 없는 요청은 거절합니다.
이 주소는 Tailscale Funnel이라 컴퓨터를 다시 켜도 바뀌지 않습니다.
"@
    Set-Content -Path $UrlFile -Value $note -Encoding UTF8
    try { Set-Clipboard -Value $url } catch { }
}

function Warm-Gemma {
    Unload-OtherModels $TrModel
    $bodyFile = Join-Path $RunDir "warmup.json"
    $outFile = Join-Path $RunDir "warmup-out.json"
    $body = '{"model":"' + $TrModel + '","stream":false,"keep_alive":"30m","messages":[{"role":"user","content":"Translate into Korean only. Reply with the translation only.\nSource:\nhello"}]}'
    Set-Content -Path $bodyFile -Value $body -Encoding ascii
    & curl.exe -s -m 180 -H "Content-Type: application/json" --data-binary "@$bodyFile" -o $outFile "http://127.0.0.1:11434/api/chat" | Out-Null
    return (Test-Path $outFile) -and ((Get-Content $outFile -Raw -ErrorAction SilentlyContinue) -match '"done"\s*:\s*true')
}

function Ensure-Ollama {
    $origin = Test-OllamaOrigin -Seconds 300
    if ($origin -eq "down" -or $origin -eq "rejected") { Start-OllamaServer }
    elseif ($origin -ne "ok") { throw "Ollama가 포트는 열었지만 아직 응답하지 않습니다. 그래픽카드 확인이 길어졌습니다." }
}

function Test-ManagerUp {
    $procs = @(Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -and $_.CommandLine -like "*C:\rtb-pc-api\manager.py*"
    })
    return ($procs.Count -gt 0) -and (Test-Listen 8092)
}

function Start-Manager {
    Unload-OtherModels $TrModel
    Stop-Stt
    Stop-Door
    Start-Sleep -Seconds 1
    $python = "C:\Python314\python.exe"
    if (-not (Test-Path $python)) { throw "Python 실행 파일이 없습니다." }
    if (-not (Test-Path (Join-Path $Root "manager.py"))) { throw "manager.py 가 없습니다." }
    Start-Logged "manager" $python @("-u", (Join-Path $Root "manager.py")) $Root | Out-Null
    if (-not (Wait-Listen 8092 20)) { throw "문 8092가 열리지 않았습니다." }
    if ($PcEngine -ne "whisper") { return }
    $file = Get-SttFile $PcSize
    $have = Test-Path $file
    if (-not $have -and $PcSize -eq "turbo" -and (Test-Path (Join-Path $Root "faster_whisper_server.py"))) { $have = $true }
    if (-not $have) { return }
    if (-not (Wait-Listen 8091 90)) { throw "받아쓰기 서버가 127.0.0.1:8091 에서 응답하지 않습니다. 로그: $LogDir\stt.err.log" }
}

function Write-PortLog([string]$text) {
    if (-not (Test-Path $LogDir)) {
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    }
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path (Join-Path $LogDir "port-exclude.log") -Value ($stamp + " " + $text) -Encoding UTF8
}

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ExcludedRangesFromNetsh {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $text = & netsh.exe interface ipv4 show excludedportrange protocol=tcp 2>&1 | Out-String
    } finally {
        $ErrorActionPreference = $prev
    }
    return @{ Text = [string]$text; Ranges = @(ConvertFrom-ExcludedPortText -Text ([string]$text)) }
}

function Format-PortBlockMessage {
    param(
        [object[]]$Hits,
        [string]$Why
    )
    $roles = @{
        11434 = "Ollama"
        8091 = "받아쓰기"
        8092 = "관리 프로그램"
    }
    $lines = @()
    foreach ($hit in $Hits) {
        if ($null -eq $hit) { continue }
        $role = $roles[[int]$hit.Port]
        if (-not $role) { $role = "서비스" }
        $lines += ("{0} 포트({1})가 Windows 제외 범위 {2}-{3} 에 들어 있습니다." -f $hit.Port, $role, $hit.Start, $hit.End)
    }
    $lead = ""
    if ($Why -eq "denied") {
        $lead = "권한 상승을 거부해서 제외 범위를 풀지 못했습니다.`r`n`r`n"
    } elseif ($Why -eq "failed") {
        $lead = "winnat를 다시 시작하지 못했습니다.`r`n`r`n"
    } elseif ($Why -eq "still") {
        $lead = "winnat를 다시 시작했는데도 제외 범위가 남아 있습니다.`r`n`r`n"
    }
    return $lead + ($lines -join "`r`n") + @"

Windows가 재부팅 뒤 이 포트를 동적 제외 범위로 잡아 프로그램을 열 수 없습니다.
관리자 권한 PowerShell에서 다음을 실행한 뒤 다시 켜세요.
net stop winnat
net start winnat
"@
}

function Restart-WinnatService {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & net.exe stop winnat | Out-Null
        & net.exe start winnat | Out-Null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Request-WinnatRestart {
    if (Test-IsAdmin) {
        Write-PortLog "관리자 권한으로 winnat를 다시 시작합니다."
        if (Restart-WinnatService) {
            Write-PortLog "winnat 재시작을 마쳤습니다."
            return "admin"
        }
        Write-PortLog "winnat 재시작이 실패했습니다."
        return "failed"
    }
    Write-PortLog "관리자 권한이 없어 권한 상승으로 winnat 재시작을 한 번 요청합니다."
    $shell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $command = "& net.exe stop winnat; & net.exe start winnat; exit `$LASTEXITCODE"
    try {
        $proc = Start-Process -FilePath $shell -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) -Verb RunAs -Wait -PassThru -WindowStyle Hidden
    } catch {
        Write-PortLog ("권한 상승이 거부되었거나 시작하지 못했습니다: " + $_.Exception.Message)
        return "denied"
    }
    if (-not $proc) {
        Write-PortLog "권한 상승 프로세스가 없습니다."
        return "denied"
    }
    Write-PortLog ("권한 상승 종료 코드 " + $proc.ExitCode)
    if ($proc.ExitCode -ne 0) { return "failed" }
    return "elevated"
}

function Ensure-ListenPorts {
    $ports = @(11434, 8091, 8092)
    $snap = Get-ExcludedRangesFromNetsh
    Write-PortLog ("제외 범위 검사`r`n" + $snap.Text)
    $hits = @(Get-BlockedPorts -Ports $ports -Ranges $snap.Ranges | Where-Object { $_ })
    if ($hits.Count -eq 0) {
        Write-PortLog "11434, 8091, 8092 는 제외 범위에 없습니다."
        return
    }
    $listed = ($hits | ForEach-Object { "{0} {1}-{2}" -f $_.Port, $_.Start, $_.End }) -join ", "
    Write-PortLog ("막힌 포트: " + $listed)
    $how = Request-WinnatRestart
    if ($how -eq "denied" -or $how -eq "failed") {
        throw (Format-PortBlockMessage -Hits $hits -Why $how)
    }
    Start-Sleep -Seconds 1
    $again = Get-ExcludedRangesFromNetsh
    Write-PortLog ("재검사`r`n" + $again.Text)
    $left = @(Get-BlockedPorts -Ports $ports -Ranges $again.Ranges | Where-Object { $_ })
    if ($left.Count -gt 0) {
        throw (Format-PortBlockMessage -Hits $left -Why "still")
    }
    Write-PortLog "winnat 재시작 후 11434, 8091, 8092 가 제외 범위에서 빠졌습니다."
}

try {
    Read-PcState
    Ensure-ListenPorts
    if (-not (Test-Path $KeyFile)) { throw "비밀 키 파일이 없습니다. install.ps1 을 먼저 실행하세요." }
    Ensure-Tailscale
    $ready = (Test-ManagerUp) -and (Test-FunnelUp)
    $warmNote = ""
    if (-not $ready) {
        Ensure-Ollama
        if (-not (Test-ManagerUp)) { Start-Manager }
        Stop-Tunnel
        Start-Funnel
        if (-not (Warm-Gemma)) { $warmNote = "번역 모델 $TrModel 준비는 끝나지 않았습니다. 페이지에서 적용을 다시 누르세요." }
    } else {
        Stop-Tunnel
    }
    $url = Get-FunnelUrl
    if (-not $url) { throw "Tailscale 주소를 읽지 못했습니다." }
    Write-UrlNote $url
    Show-Note @"
켜 두었습니다. 다음 로그인 때도 자동으로 켜집니다.

PC API 주소 (클립보드에 복사함):
$url

페이지 https://echoji-git.github.io/realtime-translator/translator.html
받아쓰기 $PcEngine $PcSize , 번역 $TrModel
비밀 키는 바탕화면의 번역PC-비밀키.txt 또는 $KeyFile 입니다.
$warmNote

이 주소는 컴퓨터를 다시 켜도 바뀌지 않습니다. 페이지에 한 번 넣고 저장하세요.
"@
} catch {
    Stop-OurStack
    $message = $_.Exception.Message
    if ($_.InvocationInfo.PositionMessage) { $message += "`r`n" + $_.InvocationInfo.PositionMessage }
    Show-Note "켜지 못했습니다.`r`n`r`n$message`r`n`r`n로그 폴더: $LogDir"
    exit 1
}
