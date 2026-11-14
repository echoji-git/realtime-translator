# 리눅스에서 가짜 whisper, Ollama, nvidia-smi 로 문을 검사한다.
import json
import os
import socket
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import manager  # noqa: E402

KEY = "test-key-v1033"
ORIGIN = "https://echoji-git.github.io"
EVIL = "https://evil.example"


class Box:
    def __init__(self):
        self.models = ["gemma3:1b", "gemma3:4b"]
        self.chat = []
        self.inference = 0
        self.lock = threading.Lock()


BOX = Box()


class MockOllama(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def _send(self, status, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        n = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/api/tags":
            self._send(404, {})
            return
        with BOX.lock:
            models = [{"name": name} for name in BOX.models]
        self._send(200, {"models": models})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        data = self._body()
        if path == "/api/pull":
            name = data.get("name")
            with BOX.lock:
                if name and name not in BOX.models:
                    BOX.models.append(name)
            self._send(200, {"status": "success"})
            return
        if path == "/api/chat":
            with BOX.lock:
                BOX.chat.append(data)
            self._send(200, {"message": {"role": "assistant", "content": "안녕"}, "done": True})
            return
        if path == "/api/generate":
            self._send(200, {"done": True})
            return
        self._send(404, {})


class MockStt(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0") or "0")
        if n:
            self.rfile.read(n)
        with BOX.lock:
            BOX.inference += 1
        raw = json.dumps({"text": "안녕"}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)


def free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def serve(handler, port):
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def call(base, method, path, key=None, body=None, origin=ORIGIN, extra=None):
    headers = {}
    if origin:
        headers["Origin"] = origin
    if key is not None:
        headers["X-RTB-Key"] = key
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if extra:
        headers.update(extra)
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read()
            return resp.status, dict(resp.headers), raw
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def header_get(headers, name):
    for key, value in headers.items():
        if key.lower() == name.lower():
            return value
    return ""


def main():
    tmp = Path(tempfile.mkdtemp(prefix="rtb-manager-"))
    (tmp / "ggml-base.bin").write_bytes(b"base")
    (tmp / "ggml-small.bin").write_bytes(b"small")
    (tmp / "manager-key.txt").write_text(KEY + "\n", encoding="utf-8")
    smi = tmp / "nvidia-smi"
    smi.write_text("#!/bin/sh\necho '1500, 6144'\n", encoding="utf-8")
    smi.chmod(0o755)
    ollama_port = free_port()
    stt_port = free_port()
    door_port = free_port()
    os.environ["RTB_ROOT"] = str(tmp)
    os.environ["RTB_STT_URL"] = "http://127.0.0.1:%s" % stt_port
    os.environ["RTB_OLLAMA_URL"] = "http://127.0.0.1:%s" % ollama_port
    os.environ["RTB_NVIDIA_SMI"] = str(smi)
    os.environ["RTB_SKIP_PROCESS"] = "1"
    os.environ["RTB_SKIP_BOOT"] = "1"
    os.environ["RTB_CORS_ORIGIN"] = ORIGIN
    serve(MockOllama, ollama_port)
    serve(MockStt, stt_port)
    host = manager.Host(tmp)
    door = manager.make_server(host, "127.0.0.1", door_port)
    threading.Thread(target=door.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%s" % door_port

    status, _headers, raw = call(base, "GET", "/manager/status")
    assert status == 401, status
    assert json.loads(raw)["error"] == "인증 필요"

    status, headers, raw = call(base, "GET", "/manager/status", key=KEY)
    assert status == 200, (status, raw)
    body = json.loads(raw)
    assert body["ok"] is True
    assert body["sensevoice"]["installed"] is False
    assert body["sensevoice"]["note"] == "설치 필요"
    assert body["files"]["base"]["exists"] is True
    assert body["vram"]["used_mb"] == 1500
    assert body["vram"]["total_mb"] == 6144
    assert header_get(headers, "Access-Control-Allow-Origin") == ORIGIN

    status, headers, _raw = call(base, "OPTIONS", "/api/chat", origin=ORIGIN, extra={
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-rtb-key",
    })
    assert status == 204, status
    assert header_get(headers, "Access-Control-Allow-Origin") == ORIGIN
    allow = header_get(headers, "Access-Control-Allow-Headers").lower()
    assert "x-rtb-key" in allow
    assert "content-type" in allow

    status, headers, _raw = call(base, "GET", "/manager/status", key=KEY, origin=EVIL)
    assert status == 200
    assert header_get(headers, "Access-Control-Allow-Origin") == ""

    status, _headers, raw = call(base, "POST", "/api/chat", key=KEY, body={"model": "gemma3:4b", "messages": [{"role": "user", "content": "hi"}]})
    assert status == 200, (status, raw)
    assert BOX.chat[-1]["model"] == "gemma3:4b"

    status, _headers, raw = call(base, "POST", "/inference", key=KEY, body=b"not-audio")
    assert status == 200, (status, raw)
    assert json.loads(raw)["text"] == "안녕"

    status, _headers, raw = call(base, "POST", "/manager/apply", key=KEY, body={
        "engine": "whisper",
        "size": "base",
        "model": "gemma3:1b",
        "command": "calc.exe",
        "path": "C:\\Windows\\System32",
    })
    assert status == 200, raw
    applied = json.loads(raw)
    assert applied["ok"] is True
    assert applied["model"] == "gemma3:1b"
    assert applied["files"]["exists"] is True
    assert applied["files"]["need_install"] is False
    assert applied["ollama"]["installed"] is True
    assert isinstance(applied["chunk_ms"], int)
    assert applied["vram"]["used_mb"] == 1500
    joined = json.dumps(host.commands)
    assert "calc.exe" not in joined
    assert "System32" not in joined
    assert "ggml-base.bin" in joined

    before = len(host.commands)
    status, _headers, raw = call(base, "POST", "/manager/apply", key=KEY, body={
        "engine": "whisper",
        "size": "huge",
        "model": "gemma3:1b",
    })
    assert status == 400, raw
    assert json.loads(raw)["error"] == "허용되지 않은 값"
    status, _headers, raw = call(base, "POST", "/manager/apply", key=KEY, body={
        "engine": "whisper",
        "size": "base",
        "model": "gemma3:1b; rm -rf /",
    })
    assert status == 400
    status, _headers, raw = call(base, "POST", "/manager/apply", key=KEY, body={
        "engine": "../door.py",
        "size": "base",
        "model": "gemma3:1b",
    })
    assert status == 400
    assert len(host.commands) == before

    status, _headers, raw = call(base, "POST", "/manager/apply", key=KEY, body={
        "engine": "sensevoice",
        "size": "base",
        "model": "gemma3:1b",
    })
    assert status == 200, raw
    sense = json.loads(raw)
    assert sense["ok"] is False
    assert sense["error"] == "설치 필요"
    state = json.loads((tmp / "manager-state.json").read_text(encoding="utf-8"))
    assert state["engine"] == "whisper"

    status, _headers, raw = call(base, "POST", "/manager/apply", key=KEY, body={
        "engine": "whisper",
        "size": "turbo",
        "model": "gemma3:4b",
    })
    assert status == 200, raw
    turbo = json.loads(raw)
    assert turbo["ok"] is False
    assert turbo["files"]["need_install"] is True
    assert "빠듯" in turbo["warning"]

    (tmp / "ggml-large-v3-turbo.bin").write_bytes(b"turbo")
    status, _headers, raw = call(base, "POST", "/manager/apply", key=KEY, body={
        "engine": "whisper",
        "size": "turbo",
        "model": "gemma2:2b",
    })
    assert status == 200, raw
    pulled = json.loads(raw)
    assert pulled["ok"] is True
    assert pulled["model"] == "gemma2:2b"
    assert pulled["ollama"]["installed"] is True
    assert "gemma2:2b" in BOX.models
    assert "ggml-large-v3-turbo.bin" in json.dumps(host.commands)

    log = (tmp / "logs" / "auth-fail.log").read_text(encoding="utf-8")
    assert "bad-key" in log
    assert KEY not in log

    limit_port = free_port()
    limited = manager.make_server(manager.Host(tmp), "127.0.0.1", limit_port)
    threading.Thread(target=limited.serve_forever, daemon=True).start()
    limit_base = "http://127.0.0.1:%s" % limit_port
    for _ in range(20):
        status, _headers, _raw = call(limit_base, "GET", "/manager/status", key="wrong")
        assert status == 401
    status, _headers, raw = call(limit_base, "GET", "/manager/status", key="wrong")
    assert status == 429, (status, raw)
    status, _headers, raw = call(limit_base, "GET", "/manager/status", key=KEY)
    assert status == 200, raw

    print("manager tests ok")
    print("vram", body["vram"], "chunk_ms", applied["chunk_ms"])


if __name__ == "__main__":
    main()
