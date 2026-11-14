# 실시간 번역 PC 매니저 v1.033

이 PC의 받아쓰기와 번역을 번역 페이지에서 고르게 합니다. 인터넷에 열린 주소는 비밀 키가 있어야만 쓸 수 있습니다.

추가 파이썬 패키지는 없습니다. Windows에 있는 Python 3.14 (`C:\Python314\python.exe`) 만 씁니다.

## 설치 방법

1. 이 zip을 풉니다.
2. PowerShell에서 설치 스크립트를 실행합니다.

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

3. 비밀 키 창이 한 번 뜹니다. 그 키는 클립보드와 바탕화면 `번역PC-비밀키.txt` 에 들어갑니다.
4. 바탕화면의 `번역PC 켜기끄기` 로 켭니다. 주소는 바탕화면 `번역PC-주소.txt` 에 적힙니다.
5. 번역 페이지를 엽니다.

https://echoji-git.github.io/realtime-translator/translator.html

6. 설정에서 전사 또는 번역을 PC API로 고릅니다.
7. PC API 주소, 비밀 키를 넣고 전사 엔진, 전사 크기, 번역 모델을 고른 뒤 `적용` 을 누릅니다.
8. 페이지에 모델 파일이 있는지, 그래픽 메모리, 조각당 시간이 나옵니다. 그다음 `저장` 을 누릅니다.

## 키를 넣는 곳

- 번역 페이지 설정의 `비밀 키` 칸. 이 브라우저에만 저장됩니다.
- PC 파일은 `C:\rtb-pc-api\manager-key.txt` 입니다.
- 처음 설치 때 바탕화면 `번역PC-비밀키.txt` 에도 적습니다. 그 창은 한 번만 뜹니다.
- 이미 키가 있으면 설치를 다시 해도 키를 바꾸지 않습니다. 새 키가 필요하면 두 파일을 지운 뒤 설치를 다시 실행하세요.

키 없는 요청은 401로 거절합니다. 페이지에서 Gemini를 쓰는 사람은 자기 키만 쓰고, 이 PC에는 닿지 않습니다.

## 고를 수 있는 값

- 전사 엔진: Whisper, SenseVoice
- 전사 크기: base, small, turbo
- 번역 모델: Ollama 1B는 `gemma3:1b`, 2B는 `gemma2:2b`, 4B는 `gemma3:4b`

SenseVoice가 없으면 `설치 필요` 만 보여 주고, 켜져 있던 Whisper는 그대로 둡니다.

turbo는 `ggml-large-v3-turbo.bin` 이 있으면 whisper-server로 켭니다. 그 파일이 없고 기존 faster-whisper 캐시가 있으면 `faster_whisper_server.py` 를 켭니다. 둘 다 없으면 설치 필요로 알려 줍니다.

4B와 turbo를 같이 적용하면 6GB 그래픽 메모리가 빠듯할 수 있어 페이지가 먼저 묻습니다.

매니저가 응답하지 않으면 페이지는 주소와 키만 저장하고 `데스크톱 설정은 직접 바꿔야 함` 이라고 보여 줍니다. 받아쓰기와 번역 요청은 그 주소로 계속 갑니다.

## 되돌리기

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\rtb-pc-api\uninstall.ps1
```

설치 전에 받아 둔 `C:\rtb-pc-api\backup-v1032` 의 스크립트로 되돌립니다. 백업이 없으면 zip에 들어 있는 옛 스크립트를 씁니다. 옛 `door.py` 가 다시 문을 맡습니다.

되돌리면 키 검사가 없어집니다. 인터넷에 열린 주소는 키 없이 다시 쓸 수 있으니, 필요할 때만 켜세요.
