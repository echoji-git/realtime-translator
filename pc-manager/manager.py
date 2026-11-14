# 실시간 번역 PC 문. 127.0.0.1:8092 에서 받아쓰기와 Ollama를 프록시하고
# 전사 엔진과 번역 모델을 바꾼다. 표준 라이브러리만 쓴다.
# 모든 요청은 X-RTB-Key 가 manager-key.txt 와 같아야 한다. OPTIONS 는 예외.

import hashlib
import hmac
import json
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ENGINE_OK = ("whisper", "sensevoice")
SIZE_OK = ("base", "small", "turbo")
MODEL_OK = ("gemma3:1b", "gemma2:2b", "gemma3:4b")
MODEL_FILE = {
    "base": "ggml-base.bin",
    "small": "ggml-small.bin",
    "turbo": "ggml-large-v3-turbo.bin",
}
MAX_BODY = 25 * 1024 * 1024
FAIL_LIMIT = 20
FAIL_WINDOW = 60.0


def default_root():
    env = os.environ.get("RTB_ROOT")
    if env:
        return Path(env)
    if os.name == "nt":
        return Path(r"C:\rtb-pc-api")
    return Path(__file__).resolve().parent


def keys_match(got, expected):
    if not got or not expected:
        return False
    left = hashlib.sha256(got.encode("utf-8")).digest()
    right = hashlib.sha256(expected.encode("utf-8")).digest()
    return hmac.compare_digest(left, right)


def silent_wav(n=6400):
    import struct
    data = b"\x00\x00" * n
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(data),
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        16000,
        32000,
        2,
        16,
        b"data",
        len(data),
    )
    return header + data


class Host:
    def __init__(self, root):
        self.root = Path(root)
        self.commands = []
        self.stt_proc = None
        self.fail_lock = threading.Lock()
        self.fails = {}
        self.state_lock = threading.Lock()
        (self.root / "logs").mkdir(parents=True, exist_ok=True)
        (self.root / "run").mkdir(parents=True, exist_ok=True)

    def key_path(self):
        return self.root / "manager-key.txt"

    def state_path(self):
        return self.root / "manager-state.json"

    def fail_log(self):
        return self.root / "logs" / "auth-fail.log"

    def load_key(self):
        try:
            return self.key_path().read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    def allowed_origin(self):
        return os.environ.get("RTB_CORS_ORIGIN", "https://echoji-git.github.io")

    def stt_url(self):
        return os.environ.get("RTB_STT_URL", "http://127.0.0.1:8091").rstrip("/")

    def ollama_url(self):
        return os.environ.get("RTB_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")

    def skip_process(self):
        return os.environ.get("RTB_SKIP_PROCESS") == "1"

    def read_state(self):
        state = {"engine": "whisper", "size": "base", "model": "gemma3:1b"}
        try:
            data = json.loads(self.state_path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            return state
        if isinstance(data, dict):
            if data.get("engine") in ENGINE_OK:
                state["engine"] = data["engine"]
            if data.get("size") in SIZE_OK:
                state["size"] = data["size"]
            if data.get("model") in MODEL_OK:
                state["model"] = data["model"]
        return state

    def write_state(self, engine, size, model):
        payload = {"engine": engine, "size": size, "model": model}
        text = json.dumps(payload, ensure_ascii=False)
        with self.state_lock:
            self.state_path().write_text(text, encoding="utf-8")
        return payload

    def log_fail(self, ip, reason, path):
        line = "%s ip=%s reason=%s path=%s\n" % (
            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            ip,
            reason,
            path,
        )
        try:
            with self.fail_log().open("a", encoding="utf-8") as handle:
                handle.write(line)
        except OSError:
            pass

    def too_many(self, ip):
        now = time.monotonic()
        with self.fail_lock:
            q = self.fails.get(ip)
            if not q:
                return False
            while q and now - q[0] > FAIL_WINDOW:
                q.popleft()
            return len(q) >= FAIL_LIMIT

    def mark_fail(self, ip):
        now = time.monotonic()
        with self.fail_lock:
            q = self.fails.setdefault(ip, deque())
            while q and now - q[0] > FAIL_WINDOW:
                q.popleft()
            q.append(now)
            while len(q) > FAIL_LIMIT + 5:
                q.popleft()

    def sensevoice_installed(self):
        env = os.environ.get("RTB_SENSEVOICE_DIR")
        dirs = []
        if env:
            dirs.append(Path(env))
        dirs.append(self.root / "sensevoice")
        for folder in dirs:
            try:
                if not folder.is_dir():
                    continue
                if (folder / "installed.flag").is_file():
                    return True
                for _ in folder.glob("*.onnx"):
                    return True
            except OSError:
                continue
        return False

    def turbo_cache(self):
        models = self.root / "models"
        if not models.is_dir():
            return False
        try:
            for path in models.rglob("model.bin"):
                try:
                    if path.is_file() and path.stat().st_size > 1_000_000:
                        return True
                except OSError:
                    continue
        except OSError:
            return False
        return False

    def file_report(self, size):
        name = MODEL_FILE.get(size, MODEL_FILE["base"])
        path = self.root / name
        exists = path.is_file()
        if size == "turbo" and not exists and (self.root / "faster_whisper_server.py").is_file() and self.turbo_cache():
            return {"exists": True, "need_install": False, "name": "faster-whisper-large-v3-turbo", "via": "faster-whisper"}
        return {"exists": exists, "need_install": not exists, "name": name, "via": "whisper.cpp" if exists else ""}

    def files_overview(self):
        return {size: self.file_report(size) for size in SIZE_OK}

    def find_whisper_exe(self):
        base = self.root / "whisper"
        if not base.is_dir():
            return None
        found = sorted(base.rglob("whisper-server.exe"))
        return found[0] if found else None

    def python_exe(self):
        venv = self.root / "fw-venv" / "Scripts" / "python.exe"
        if venv.is_file():
            return venv
        env = os.environ.get("RTB_PYTHON")
        if env:
            return Path(env)
        return Path(r"C:\Python314\python.exe")

    def whisper_argv(self, size):
        report = self.file_report(size)
        if not report["exists"]:
            return None
        if report.get("via") == "faster-whisper":
            py = self.python_exe()
            script = self.root / "faster_whisper_server.py"
            return [str(py), "-u", str(script)]
        exe = self.find_whisper_exe()
        model = self.root / report["name"]
        if exe is None and not self.skip_process():
            return None
        return [
            str(exe) if exe is not None else "whisper-server.exe",
            "--host", "127.0.0.1",
            "--port", "8091",
            "-m", str(model),
            "-l", "auto",
            "--no-flash-attn",
        ]

    def stop_stt(self):
        self.commands.append(["stop-stt"])
        if self.skip_process():
            return
        proc = self.stt_proc
        self.stt_proc = None
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        pid_file = self.root / "run" / "stt.pid"
        if pid_file.is_file():
            try:
                pid = int(pid_file.read_text(encoding="ascii").strip())
            except (OSError, ValueError):
                pid = 0
            if pid > 0:
                subprocess.run(
                    ["taskkill", "/F", "/PID", str(pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            try:
                pid_file.unlink()
            except OSError:
                pass
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/IM", "whisper-server.exe"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    def wait_port(self, port, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            with socket.socket() as sock:
                sock.settimeout(0.3)
                try:
                    sock.connect(("127.0.0.1", port))
                    return True
                except OSError:
                    time.sleep(0.3)
        return False

    def start_stt(self, engine, size):
        if engine == "sensevoice":
            installed = self.sensevoice_installed()
            return {
                "started": False,
                "installed": installed,
                "need_install": not installed,
                "name": "sensevoice",
            }
        report = self.file_report(size)
        if not report["exists"]:
            return {
                "started": False,
                "exists": False,
                "need_install": True,
                "name": report["name"],
            }
        argv = self.whisper_argv(size)
        if not argv:
            return {
                "started": False,
                "exists": True,
                "need_install": False,
                "name": report["name"],
                "error": "whisper-server.exe 가 없습니다",
            }
        self.commands.append(argv)
        if self.skip_process():
            return {
                "started": True,
                "exists": True,
                "need_install": False,
                "name": report["name"],
                "via": report.get("via") or "",
            }
        self.stop_stt()
        log_out = open(self.root / "logs" / "stt.log", "ab")
        log_err = open(self.root / "logs" / "stt.err.log", "ab")
        proc = subprocess.Popen(
            argv,
            cwd=str(self.root),
            stdout=log_out,
            stderr=log_err,
        )
        self.stt_proc = proc
        (self.root / "run" / "stt.pid").write_text(str(proc.pid), encoding="ascii")
        if not self.wait_port(8091, 90):
            return {
                "started": False,
                "exists": True,
                "need_install": False,
                "name": report["name"],
                "error": "받아쓰기 서버가 열리지 않았습니다",
            }
        return {
            "started": True,
            "exists": True,
            "need_install": False,
            "name": report["name"],
            "via": report.get("via") or "",
        }

    def http_json(self, method, url, payload=None, timeout=30):
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
        if not raw:
            return status, None
        try:
            return status, json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return status, None

    def ollama_models(self):
        try:
            _status, body = self.http_json("GET", self.ollama_url() + "/api/tags", timeout=8)
        except (urllib.error.URLError, TimeoutError, OSError):
            return None
        names = []
        if isinstance(body, dict):
            for item in body.get("models") or []:
                if isinstance(item, dict) and item.get("name"):
                    names.append(item["name"])
        return names

    def ensure_model(self, model):
        names = self.ollama_models()
        if names is None:
            return {"installed": False, "need_install": True, "pulled": False, "error": "Ollama가 응답하지 않습니다"}
        if model in names:
            return {"installed": True, "need_install": False, "pulled": False}
        if os.environ.get("RTB_OLLAMA_PULL", "1") == "0":
            return {"installed": False, "need_install": True, "pulled": False}
        try:
            self.http_json("POST", self.ollama_url() + "/api/pull", {"name": model, "stream": False}, timeout=600)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            return {"installed": False, "need_install": True, "pulled": False, "error": str(exc)}
        names = self.ollama_models() or []
        installed = model in names
        return {"installed": installed, "need_install": not installed, "pulled": True}

    def unload_others(self, keep):
        if os.environ.get("RTB_OLLAMA_UNLOAD", "1") == "0":
            return
        for name in MODEL_OK:
            if name == keep:
                continue
            try:
                self.http_json(
                    "POST",
                    self.ollama_url() + "/api/generate",
                    {"model": name, "keep_alive": 0, "prompt": ""},
                    timeout=20,
                )
            except (urllib.error.URLError, TimeoutError, OSError):
                continue

    def vram(self):
        cmd = os.environ.get("RTB_NVIDIA_SMI", "nvidia-smi")
        try:
            out = subprocess.check_output(
                [cmd, "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
                timeout=8,
                text=True,
                stderr=subprocess.DEVNULL,
            )
        except (OSError, subprocess.SubprocessError, subprocess.TimeoutExpired):
            return {"used_mb": None, "total_mb": None}
        line = ""
        for row in out.splitlines():
            if row.strip():
                line = row.strip()
                break
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 2:
            return {"used_mb": None, "total_mb": None}
        try:
            return {"used_mb": int(float(parts[0])), "total_mb": int(float(parts[1]))}
        except ValueError:
            return {"used_mb": None, "total_mb": None}

    def warmup(self, model):
        result = {"chunk_ms": None, "translate_ms": None}
        started = time.perf_counter()
        try:
            self.http_json(
                "POST",
                self.ollama_url() + "/api/chat",
                {
                    "model": model,
                    "stream": False,
                    "messages": [{"role": "user", "content": "Translate into Korean only. Reply with the translation only.\nSource:\nhi"}],
                },
                timeout=180,
            )
            result["translate_ms"] = int((time.perf_counter() - started) * 1000)
        except (urllib.error.URLError, TimeoutError, OSError):
            result["translate_ms"] = None
        wav = silent_wav()
        boundary = "rtbwarm"
        body = (
            ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"warm.wav\"\r\n"
             "Content-Type: audio/wav\r\n\r\n" % boundary).encode("utf-8")
            + wav
            + ("\r\n--%s\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n--%s--\r\n" % (boundary, boundary)).encode("utf-8")
        )
        req = urllib.request.Request(
            self.stt_url() + "/inference",
            data=body,
            headers={"Content-Type": "multipart/form-data; boundary=" + boundary},
            method="POST",
        )
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                resp.read()
            result["chunk_ms"] = int((time.perf_counter() - t0) * 1000)
        except (urllib.error.URLError, TimeoutError, OSError):
            result["chunk_ms"] = None
        return result

    def boot(self):
        state = self.read_state()
        try:
            result = {"skipped": True}
            if state["engine"] == "whisper":
                result = self.start_stt(state["engine"], state["size"])
            (self.root / "logs" / "boot.log").write_text(
                json.dumps(result, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception as exc:
            try:
                (self.root / "logs" / "boot.log").write_text(str(exc), encoding="utf-8")
            except OSError:
                pass

    def status(self):
        state = self.read_state()
        names = self.ollama_models()
        ollama = {}
        for model in MODEL_OK:
            installed = bool(names) and model in names if names is not None else False
            if names is None:
                ollama[model] = {"installed": False, "need_install": True, "error": "Ollama가 응답하지 않습니다"}
            else:
                ollama[model] = {"installed": installed, "need_install": not installed}
        sense = self.sensevoice_installed()
        return {
            "ok": True,
            "engine": state["engine"],
            "size": state["size"],
            "model": state["model"],
            "sensevoice": {"installed": sense, "note": "" if sense else "설치 필요"},
            "files": self.files_overview(),
            "ollama": ollama,
            "vram": self.vram(),
        }

    def apply(self, engine, size, model):
        warning = ""
        if model == "gemma3:4b" and size == "turbo":
            warning = "4B와 turbo는 6GB에서 그래픽 메모리가 빠듯할 수 있습니다."
        sense = self.sensevoice_installed()
        if engine == "sensevoice" and not sense:
            return {
                "ok": False,
                "error": "설치 필요",
                "engine": engine,
                "size": size,
                "model": model,
                "sensevoice": {"installed": False, "note": "설치 필요"},
                "files": self.file_report(size),
                "ollama": {"installed": False, "need_install": False},
                "vram": self.vram(),
                "chunk_ms": None,
                "warning": warning,
            }
        report = self.file_report(size) if engine == "whisper" else {"exists": True, "need_install": False, "name": "sensevoice"}
        if engine == "whisper" and not report["exists"]:
            return {
                "ok": False,
                "error": "설치 필요",
                "engine": engine,
                "size": size,
                "model": model,
                "sensevoice": {"installed": sense, "note": "" if sense else "설치 필요"},
                "files": report,
                "ollama": {"installed": False, "need_install": False},
                "vram": self.vram(),
                "chunk_ms": None,
                "warning": warning,
            }
        ollama = self.ensure_model(model)
        if not ollama.get("installed"):
            return {
                "ok": False,
                "error": "설치 필요",
                "engine": engine,
                "size": size,
                "model": model,
                "sensevoice": {"installed": sense, "note": "" if sense else "설치 필요"},
                "files": report,
                "ollama": ollama,
                "vram": self.vram(),
                "chunk_ms": None,
                "warning": warning,
            }
        started = self.start_stt(engine, size)
        if engine == "whisper" and not started.get("started"):
            return {
                "ok": False,
                "error": started.get("error") or "받아쓰기 서버를 켜지 못했습니다",
                "engine": engine,
                "size": size,
                "model": model,
                "sensevoice": {"installed": sense, "note": "" if sense else "설치 필요"},
                "files": report,
                "ollama": ollama,
                "vram": self.vram(),
                "chunk_ms": None,
                "warning": warning,
            }
        self.write_state(engine, size, model)
        self.unload_others(model)
        warm = self.warmup(model)
        return {
            "ok": True,
            "engine": engine,
            "size": size,
            "model": model,
            "sensevoice": {"installed": sense, "note": "" if sense else "설치 필요"},
            "files": report,
            "ollama": ollama,
            "vram": self.vram(),
            "chunk_ms": warm.get("chunk_ms"),
            "translate_ms": warm.get("translate_ms"),
            "warning": warning,
        }


def route_of(path):
    clean = path.split("?", 1)[0]
    if ".." in clean or "\\" in clean or "://" in clean:
        return None
    if clean == "/manager/status" or clean == "/manager/apply":
        return ("manager", clean)
    if clean == "/inference" or clean.startswith("/inference/"):
        return ("stt", path)
    if clean == "/api" or clean.startswith("/api/"):
        return ("ollama", path)
    return None


class Handler(BaseHTTPRequestHandler):
    hostapi = None
    protocol_version = "HTTP/1.1"

    def version_string(self):
        return "RTB"

    def log_message(self, fmt, *args):
        return

    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin != self.hostapi.allowed_origin():
            return
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-RTB-Key")
        self.send_header("Access-Control-Max-Age", "600")

    def drain(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            return
        if length <= 0 or length > MAX_BODY:
            return
        remaining = length
        while remaining:
            chunk = self.rfile.read(min(65536, remaining))
            if not chunk:
                break
            remaining -= len(chunk)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def reject(self, status, error, reason):
        ip = self.client_address[0] if self.client_address else ""
        path = self.path.split("?", 1)[0]
        self.hostapi.log_fail(ip, reason, path)
        if status == 401:
            self.hostapi.mark_fail(ip)
        self.drain()
        self.send_json(status, {"ok": False, "error": error})

    def authorized(self):
        ip = self.client_address[0] if self.client_address else ""
        got = self.headers.get("X-RTB-Key", "")
        if keys_match(got, self.hostapi.load_key()):
            return True
        if self.hostapi.too_many(ip):
            self.drain()
            self.hostapi.log_fail(ip, "rate", self.path.split("?", 1)[0])
            self.send_json(429, {"ok": False, "error": "시도가 너무 많습니다"})
            return False
        self.reject(401, "인증 필요", "bad-key")
        return False

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self.send_json(400, {"ok": False, "error": "본문 길이가 잘못되었습니다"})
            return None
        if length < 0 or length > MAX_BODY:
            self.send_json(400, {"ok": False, "error": "본문이 너무 큽니다"})
            return None
        if length == 0:
            return b""
        return self.rfile.read(length)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def do_GET(self):
        if not self.authorized():
            return
        self.dispatch(None)

    def do_POST(self):
        if not self.authorized():
            return
        body = self.read_body()
        if body is None:
            return
        self.dispatch(body)

    def dispatch(self, body):
        routed = route_of(self.path)
        if routed is None:
            self.send_json(404, {"ok": False, "error": "없는 경로"})
            return
        kind, target = routed
        if kind == "manager":
            self.manager(target, body)
            return
        self.proxy(kind, target, body)

    def manager(self, path, body):
        if path == "/manager/status":
            if self.command != "GET":
                self.send_json(405, {"ok": False, "error": "허용되지 않은 메서드"})
                return
            self.send_json(200, self.hostapi.status())
            return
        if path == "/manager/apply":
            if self.command != "POST":
                self.send_json(405, {"ok": False, "error": "허용되지 않은 메서드"})
                return
            try:
                data = json.loads(body.decode("utf-8") if body else "")
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_json(400, {"ok": False, "error": "허용되지 않은 값"})
                return
            if not isinstance(data, dict):
                self.send_json(400, {"ok": False, "error": "허용되지 않은 값"})
                return
            engine = data.get("engine")
            size = data.get("size")
            model = data.get("model")
            if engine not in ENGINE_OK or size not in SIZE_OK or model not in MODEL_OK:
                self.send_json(400, {"ok": False, "error": "허용되지 않은 값"})
                return
            self.send_json(200, self.hostapi.apply(engine, size, model))
            return
        self.send_json(404, {"ok": False, "error": "없는 경로"})

    def proxy(self, kind, path, body):
        base = self.hostapi.stt_url() if kind == "stt" else self.hostapi.ollama_url()
        url = base + path
        headers = {}
        for key, value in self.headers.items():
            low = key.lower()
            if low in ("host", "content-length", "connection", "origin", "x-rtb-key", "transfer-encoding"):
                continue
            headers[key] = value
        req = urllib.request.Request(url, data=body if body else None, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = resp.read()
                status = resp.status
                upstream = []
                for key, value in resp.headers.items():
                    if key.lower() in ("transfer-encoding", "content-length", "connection", "access-control-allow-origin"):
                        continue
                    upstream.append((key, value))
        except urllib.error.HTTPError as exc:
            data = exc.read()
            status = exc.code
            upstream = []
        except Exception as exc:
            data = str(exc).encode("utf-8", "replace")
            self.send_response(502)
            self.cors()
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(status)
        self.cors()
        for key, value in upstream:
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)


def make_server(hostapi, host, port):
    Handler.hostapi = hostapi

    class Bound(Handler):
        pass

    Bound.hostapi = hostapi
    return ThreadingHTTPServer((host, port), Bound)


def main():
    root = default_root()
    hostapi = Host(root)
    host = os.environ.get("RTB_HOST", "127.0.0.1")
    port = int(os.environ.get("RTB_PORT", "8092"))
    if os.environ.get("RTB_SKIP_BOOT") != "1":
        threading.Thread(target=hostapi.boot, name="rtb-boot", daemon=True).start()
    server = make_server(hostapi, host, port)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
