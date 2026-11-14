from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import urllib.request

TRANSLATE_MODEL = "gemma3:1b"
REWRITE_FROM = "gemma3:4b"

ROUTES = (
    ("/inference", "http://127.0.0.1:8091"),
    ("/api", "http://127.0.0.1:11434"),
)


def rewrite_translate_model(path, payload):
    """페이지에 남아 있는 gemma3:4b 요청을 이 PC의 1B 모델로 바꿉니다."""
    if not payload or not path.startswith("/api"):
        return payload
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return payload
    if isinstance(data, dict) and data.get("model") == REWRITE_FROM:
        data["model"] = TRANSLATE_MODEL
        return json.dumps(data, ensure_ascii=False).encode("utf-8")
    return payload


class Door(BaseHTTPRequestHandler):
    def _proxy(self):
        target = None
        for prefix, base in ROUTES:
            if self.path.startswith(prefix):
                target = base + self.path
                break
        if target is None:
            body = b"not found"
            self.send_response(404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        payload = self.rfile.read(length) if length else None
        payload = rewrite_translate_model(self.path, payload)
        req = urllib.request.Request(target, data=payload, method=self.command)
        for key, value in self.headers.items():
            if key.lower() in ("host", "content-length"):
                continue
            req.add_header(key, value)
        if target.startswith("http://127.0.0.1:11434"):
            req.add_header("Host", "127.0.0.1:11434")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = resp.read()
                self.send_response(resp.status)
                for key, value in resp.headers.items():
                    if key.lower() in ("transfer-encoding", "content-length", "connection"):
                        continue
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except Exception as exc:
            data = str(exc).encode("utf-8", "replace")
            self.send_response(502)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    def do_GET(self):
        self._proxy()

    def do_POST(self):
        self._proxy()

    def do_OPTIONS(self):
        self._proxy()

    def log_message(self, fmt, *args):
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8092), Door).serve_forever()
