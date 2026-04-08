#!/usr/bin/env python3
"""
CC-Bridge: Claude Code Web Gateway
A Python web service that fronts Claude Code CLI via HTTP/WebSocket.
"""

import asyncio
import json
import os
import shutil
import subprocess
import select
import sys
import threading
import time
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional

PORT = int(os.environ.get("PORT", "3001"))
MODEL = os.environ.get("CLAUDE_MODEL", "codex")
SESSION_TIMEOUT = int(os.environ.get("SESSION_TIMEOUT_SECS", "1800"))

# ── PtySession ────────────────────────────────────────────────────────────────

class PtySession:
    def __init__(self, session_id: str, work_dir: str):
        self.id = session_id
        self.work_dir = work_dir
        self.proc: Optional[subprocess.Popen] = None

    def start(self, model: str) -> None:
        os.makedirs(self.work_dir, exist_ok=True)
        self.proc = subprocess.Popen(
            ["claude", "--model", model],
            cwd=self.work_dir,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
        )
        time.sleep(0.8)
        self._drain()

    def _drain(self) -> None:
        if self.proc and self.proc.stdout:
            while True:
                r, _, _ = select.select([self.proc.stdout], [], [], 0.01)
                if not r:
                    break
                try:
                    self.proc.stdout.read(1)
                except:
                    break

    def send(self, msg: str) -> None:
        if self.proc and self.proc.stdin:
            self.proc.stdin.write((msg + "\n").encode())
            self.proc.stdin.flush()

    def read_output(self, timeout: float = 30.0) -> str:
        if not self.proc or not self.proc.stdout:
            return ""
        result = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            r, _, _ = select.select([self.proc.stdout], [], [], 0.2)
            if r:
                try:
                    ch = self.proc.stdout.read(1)
                    if ch:
                        result.append(ch.decode("utf-8", errors="replace"))
                except:
                    break
            else:
                if self.proc.poll() is not None:
                    break
        return "".join(result)

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self) -> None:
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()

# ── Session Manager ────────────────────────────────────────────────────────────

class SessionManager:
    def __init__(self):
        self._sessions = {}
        self._lock = threading.Lock()

    def create(self) -> PtySession:
        sid = uuid.uuid4().hex[:8]
        work_dir = f"/tmp/cc-sessions/{sid}"
        session = PtySession(sid, work_dir)
        session.start(MODEL)
        with self._lock:
            self._sessions[sid] = session
        return session

    def remove(self, sid: str) -> None:
        with self._lock:
            session = self._sessions.pop(sid, None)
        if session:
            session.stop()
        shutil.rmtree(f"/tmp/cc-sessions/{sid}", ignore_errors=True)

    def count(self) -> int:
        with self._lock:
            return len(self._sessions)

MANAGER = SessionManager()

# ── HTTP Handler ───────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"status": "ok", "sessions": MANAGER.count()})
        elif self.path in ("/", "/index.html"):
            self.serve_html()
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/api/chat":
            return self.send_json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            req = json.loads(body)
        except:
            return self.send_json(400, {"error": "invalid json"})
        msg = req.get("message", "").strip()
        if not msg:
            return self.send_json(400, {"error": "empty message"})

        # Run in thread to avoid blocking HTTP server
        def work():
            sid = None
            try:
                session = MANAGER.create()
                sid = session.id
                session.send(msg)
                reply = session.read_output(timeout=SESSION_TIMEOUT)
                MANAGER.remove(sid)
                return reply or "(no response)"
            except Exception as e:
                if sid:
                    MANAGER.remove(sid)
                return f"error: {e}"

        # Execute synchronously (PTY ops are already blocking)
        reply = work()
        self.send_json(200, {"reply": reply})

    def serve_html(self) -> None:
        html = INDEX_HTML.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", len(html))
        self.end_headers()
        self.wfile.write(html)

# ── WebSocket ─────────────────────────────────────────────────────────────────

async def ws_client_loop(session: PtySession, ws_path: str, host: str, port: int):
    """Async WebSocket client that bridges PTY output to server."""
    import websockets.asyncio.client as ws_client

    uri = f"ws://{host}:{port}{ws_path}"
    try:
        async with ws_client.connect(uri) as ws:
            print(f"[WS bridge {session.id}] connected to {uri}")

            async def pump_pty():
                while True:
                    if not session.is_alive():
                        break
                    loop = asyncio.get_event_loop()
                    try:
                        output = await loop.run_in_executor(
                            None, lambda: session.read_output(timeout=3.0)
                        )
                        if output.strip():
                            await ws.send(json.dumps({"type": "reply", "content": output}))
                    except Exception:
                        break
                    await asyncio.sleep(0.1)

            pump_task = asyncio.create_task(pump_pty())

            try:
                async for msg in ws:
                    try:
                        data = json.loads(msg)
                        if data.get("type") == "message":
                            content = data.get("content", "").strip()
                            if content:
                                loop = asyncio.get_event_loop()
                                await loop.run_in_executor(None, lambda: session.send(content))
                    except Exception:
                        pass
            finally:
                pump_task.cancel()
    except Exception as e:
        print(f"[WS bridge {session.id}] error: {e}")


async def ws_handler(reader, writer):
    """Handle incoming WebSocket connection on port 3002."""
    import websockets.asyncio.server as ws_server

    # Perform WebSocket handshake
    try:
        async with ws_server.SERVER(
            ws_server.ServeHttp(reader, writer, ws_server.Middleware(lambda h: None))
        ) as ws:
            session = MANAGER.create()
            sid = session.id
            print(f"[WS] {sid} connected")

            async def pump_ws():
                async for msg in ws:
                    try:
                        data = json.loads(msg)
                        if data.get("type") == "message":
                            content = data.get("content", "").strip()
                            if content:
                                session.send(content)
                    except Exception:
                        pass

            async def pump_pty():
                while True:
                    if not session.is_alive():
                        break
                    try:
                        output = session.read_output(timeout=3.0)
                        if output.strip():
                            await ws.send(json.dumps({"type": "reply", "content": output}))
                    except Exception:
                        break
                    await asyncio.sleep(0.1)

            t1 = asyncio.create_task(pump_ws())
            t2 = asyncio.create_task(pump_pty())
            try:
                await asyncio.gather(t1, t2, return_exceptions=True)
            finally:
                t1.cancel()
                t2.cancel()
                MANAGER.remove(sid)
                print(f"[WS] {sid} disconnected")
    except Exception as e:
        print(f"[WS] handler error: {e}")


async def run_ws_server(port: int):
    server = await asyncio.start_server(ws_handler, "0.0.0.0", port)
    print(f"WebSocket server on 0.0.0.0:{port}")
    async with server:
        await server.serve_forever()


# ── HTML ──────────────────────────────────────────────────────────────────────

INDEX_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>CC-Bridge</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
  #header { padding: 16px 24px; background: #1a1a2e; border-bottom: 1px solid #333; font-size: 16px; font-weight: 600; color: #7ec8e3; }
  #status { font-size: 12px; color: #888; font-weight: 400; margin-left: 8px; }
  #chat { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 70%; padding: 12px 16px; border-radius: 12px; font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #2563eb; color: white; border-bottom-right-radius: 4px; }
  .msg.assistant { align-self: flex-start; background: #1e1e2e; border: 1px solid #333; border-bottom-left-radius: 4px; }
  .msg.system { align-self: center; background: #222; color: #666; font-size: 12px; border-radius: 8px; }
  #input-area { padding: 16px 24px; background: #1a1a2e; border-top: 1px solid #333; display: flex; gap: 12px; }
  #input { flex: 1; background: #0a0a0a; border: 1px solid #333; color: #e0e0e0; padding: 12px 16px; border-radius: 8px; font-size: 14px; outline: none; }
  #input:focus { border-color: #2563eb; }
  #send { background: #2563eb; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; cursor: pointer; }
  #send:hover { background: #1d4ed8; }
  .typing { color: #555; font-size: 13px; padding: 4px 0; font-style: italic; }
</style>
</head>
<body>
<div id="header">CC-Bridge<span id="status">● Connecting...</span></div>
<div id="chat"><div class="msg system">Connecting to Claude Code...</div></div>
<div id="input-area">
  <input id="input" placeholder="Ask Claude Code..." autocomplete="off" />
  <button id="send" onclick="sendMsg()">Send</button>
</div>
<script>
const chat = document.getElementById('chat');
const inp = document.getElementById('input');
const status = document.getElementById('status');
const WS_PORT = 3002;
let ws;

function connect() {
  ws = new WebSocket(`ws://${location.hostname}:${WS_PORT}/ws`);
  ws.onopen = () => { status.textContent = '● Connected'; status.style.color = '#4ade80'; addMsg('system', 'Connected. Ready.'); };
  ws.onclose = () => { status.textContent = '● Disconnected'; status.style.color = '#ef4444'; addMsg('system', 'Disconnected. Refresh to reconnect.'); };
  ws.onerror = () => { status.textContent = '● Error'; status.style.color = '#ef4444'; };
  ws.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'reply') { append(d.content); stopTyping(); }
    } catch {}
  };
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function append(text) {
  let last = chat.lastElementChild;
  if (!last || last.className !== 'msg assistant') {
    last = document.createElement('div');
    last.className = 'msg assistant';
    chat.appendChild(last);
  }
  last.textContent += text;
  chat.scrollTop = chat.scrollHeight;
}

let typingEl;
function startTyping() {
  if (typingEl) return;
  typingEl = document.createElement('div');
  typingEl.className = 'msg assistant typing';
  typingEl.textContent = 'typing...';
  chat.appendChild(typingEl);
  chat.scrollTop = chat.scrollHeight;
}
function stopTyping() {
  if (typingEl) { typingEl.remove(); typingEl = null; }
}

function sendMsg() {
  const text = inp.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  addMsg('user', text);
  inp.value = '';
  startTyping();
  ws.send(JSON.stringify({ type: 'message', content: text }));
}

inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });
connect();
</script>
</body>
</html>
"""

# ── Main ───────────────────────────────────────────────────────────────────────

async def main():
    os.makedirs("/tmp/cc-sessions", exist_ok=True)
    print(f"CC-Bridge starting — HTTP: {PORT}, WS: {PORT+1}, model={MODEL}")

    # HTTP server in thread
    http_server = HTTPServer(("0.0.0.0", PORT), Handler)
    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()
    print(f"HTTP server on 0.0.0.0:{PORT}")

    # WebSocket server
    await run_ws_server(PORT + 1)

if __name__ == "__main__":
    asyncio.run(main())
