"""
Claude Code runtime for the JARVIS memory HUD.

The brain is your own `claude` CLI, running headless (`claude -p`) with
`--output-format stream-json`. That means it authenticates the same way your
normal Claude Code sessions do — your subscription, no API key, no per-token
billing — and it keeps the same tools, MCP servers, skills and CLAUDE.md
context that the interactive CLI has.

The process is kept alive between turns (`--input-format stream-json`) and is
started before the first question arrives. Launching the CLI and connecting its
MCP servers costs 3-6 seconds; paying that once instead of on every turn is the
difference between a pause and a conversation.

Never pass --bare: it forces ANTHROPIC_API_KEY auth and would bypass the
subscription this whole dashboard is built around.
"""
import atexit
import collections
import json
import os
import shlex
import shutil
import subprocess
import threading
import time
import uuid

MODEL = os.environ.get("JARVIS_MODEL", "").strip()
WORKDIR = os.path.expanduser(os.environ.get("JARVIS_WORKDIR", os.getcwd()))
# bypassPermissions by default: a headless `claude -p` can't surface a permission
# prompt, so any gated tool (MCP connectors, web search) would silently fail
# otherwise. This also lets JARVIS take unattended actions (send/delete/shell) —
# see the Security notes in README. Set JARVIS_PERMISSION=acceptEdits to narrow it.
PERMISSION = os.environ.get("JARVIS_PERMISSION", "bypassPermissions").strip()
RUNTIME = os.environ.get("JARVIS_RUNTIME", "auto").strip().lower()   # auto|claude|mock
IDLE_TIMEOUT = int(os.environ.get("JARVIS_TIMEOUT", "180"))
RAW_LOG = os.environ.get("JARVIS_RAW_LOG", "").strip()

# One turn at a time: session state is shared, and the browser Escape key must
# be able to kill real backend work, not just the fetch.
EXECUTION_LOCK = threading.RLock()
_BRAIN = None            # the live claude process, if any
_TURN = None             # the one answering right now, for cancel_active()
_BRAIN_LOCK = threading.Lock()

# Hook chatter and internal bookkeeping the HUD should never render.
_NOISE_SUBTYPES = {"hook_started", "hook_response", "post_turn_summary",
                   "compact_boundary", "mcp_status"}


def valid_session(sid):
    """Claude Code session ids are UUIDs."""
    try:
        return bool(sid) and str(uuid.UUID(str(sid))) == str(sid).lower()
    except (ValueError, AttributeError, TypeError):
        return False


def _claude_base():
    configured = os.environ.get("CLAUDE_CMD", "").strip()
    if configured:
        return shlex.split(configured)
    exe = shutil.which("claude")
    if exe:
        return [exe]
    local = os.path.expanduser("~/.local/bin/claude")
    if os.path.exists(local):
        return [local]
    return ["claude"]


def _can_launch():
    try:
        p = subprocess.run(_claude_base() + ["--version"], cwd=WORKDIR, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        return p.returncode == 0, (p.stdout or p.stderr).strip()
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def runtime_kind():
    if RUNTIME in ("mock", "claude"):
        return RUNTIME
    ok, _ = _can_launch()
    return "claude" if ok else "mock"


def version():
    ok, detail = _can_launch()
    return detail if ok else "unavailable"


def build_command(session_id=None, system=None):
    cmd = _claude_base() + [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
    ]
    if valid_session(session_id):
        cmd += ["--resume", str(session_id)]
    if MODEL:
        cmd += ["--model", MODEL]
    if PERMISSION:
        cmd += ["--permission-mode", PERMISSION]
    if system:
        cmd += ["--append-system-prompt", system]
    return cmd


def _env():
    env = dict(os.environ)
    home = os.path.expanduser("~")
    env["PATH"] = ":".join(dict.fromkeys([
        env.get("PATH", ""), os.path.join(home, ".local", "bin"),
        "/opt/homebrew/bin", "/usr/local/bin",
        os.path.join(home, ".npm-global", "bin"),
        "/usr/bin", "/bin", "/usr/sbin", "/sbin",
    ]))
    return env


def _open_raw_log():
    if not RAW_LOG:
        return None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(os.path.expanduser(RAW_LOG), flags, 0o600)
        return os.fdopen(fd, "w", encoding="utf-8", errors="replace")
    except OSError:
        return None


def _short(value, limit=90):
    """Collapse a tool input dict into one readable line for the action log."""
    if isinstance(value, dict):
        for key in ("command", "query", "prompt", "file_path", "pattern", "path", "url"):
            if key in value and isinstance(value[key], str):
                value = value[key]
                break
        else:
            value = json.dumps(value)
    text = " ".join(str(value).split())
    return text[:limit] + ("…" if len(text) > limit else "")


class _Brain:
    """One long-lived claude process, fed one user message per turn on stdin."""

    def __init__(self, session_id, system):
        self.system = system
        self.resumed = str(session_id) if valid_session(session_id) else None
        self.session = None          # learned from the event stream
        self.turns = 0
        self.lines = collections.deque()
        self.lock = threading.Lock()
        self.eof = threading.Event()
        self.errbuf = collections.deque(maxlen=120)
        self.proc = subprocess.Popen(
            build_command(self.resumed, system), cwd=WORKDIR, text=True, bufsize=1,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=_env())
        threading.Thread(target=self._pump_out, daemon=True).start()
        threading.Thread(target=self._pump_err, daemon=True).start()

    def _pump_out(self):
        raw = _open_raw_log()
        try:
            for ln in self.proc.stdout:
                if raw:
                    raw.write(ln); raw.flush()
                with self.lock:
                    self.lines.append(ln)
        finally:
            self.eof.set()
            try:
                if raw:
                    raw.close()
            except Exception:
                pass

    def _pump_err(self):
        try:
            for ln in self.proc.stderr:
                self.errbuf.append(ln.rstrip())
        except Exception:
            pass

    def alive(self):
        return self.proc.poll() is None

    def fits(self, session_id, system):
        """Can this process take a turn for that conversation?"""
        if not self.alive() or self.system != system:
            return False
        if valid_session(session_id):
            sid = str(session_id)
            return sid == self.session or (self.turns == 0 and sid == self.resumed)
        # A new conversation needs a process that has not held one yet.
        return self.turns == 0 and not self.resumed

    def send(self, message, context):
        """The per-turn context rides in the user message: the system prompt is
        fixed when the process starts, and it has to outlive the turn."""
        with self.lock:
            self.lines.clear()       # nothing from an earlier turn leaks into this one
        text = f"<context>\n{context}\n</context>\n\n{message}" if context else message
        self.proc.stdin.write(json.dumps(
            {"type": "user", "message": {"role": "user", "content": text}}) + "\n")
        self.proc.stdin.flush()
        self.turns += 1

    def next_line(self):
        with self.lock:
            return self.lines.popleft() if self.lines else None

    def stop(self):
        try:
            if self.proc.poll() is None:
                self.proc.terminate()
            threading.Thread(target=self.proc.wait, daemon=True).start()   # reap it
        except Exception:
            pass


def _discard(brain):
    """Caller holds _BRAIN_LOCK."""
    global _BRAIN
    if brain is None:
        return
    brain.stop()
    if _BRAIN is brain:
        _BRAIN = None


def _acquire(session_id, system):
    """The live process if it can take this turn, otherwise a new one."""
    global _BRAIN
    with _BRAIN_LOCK:
        if _BRAIN is not None and not _BRAIN.fits(session_id, system):
            _discard(_BRAIN)
        if _BRAIN is None:
            _BRAIN = _Brain(session_id, system)
        return _BRAIN


def prewarm(session_id=None, system=None):
    """Start the process before it is needed, so a question never waits for the
    CLI to launch. Does nothing if one is already up."""
    global _BRAIN
    with _BRAIN_LOCK:
        if _BRAIN is not None and _BRAIN.alive():
            return
        try:
            _BRAIN = _Brain(session_id, system)
        except Exception:  # noqa: BLE001 — no CLI yet; the turn itself will say so
            _BRAIN = None


def cancel_active():
    with _BRAIN_LOCK:
        brain = _TURN
        if brain is None or not brain.alive():
            return False
        system = brain.system
        _discard(brain)
    prewarm(None, system)    # the next question opens a new conversation; have it ready
    return True


@atexit.register
def _shutdown():
    with _BRAIN_LOCK:
        _discard(_BRAIN)


def run_claude(message, session_id=None, system=None, context=None):
    with EXECUTION_LOCK:
        yield from _run_locked(message, session_id, system, context)


def _run_locked(message, session_id=None, system=None, context=None):
    global _TURN
    started = time.monotonic()

    brain = None
    for attempt in (1, 2):
        try:
            brain = _acquire(session_id, system)
            brain.send(message, context)
            break
        except FileNotFoundError:
            raise RuntimeError("claude CLI not found. Install Claude Code or set CLAUDE_CMD.")
        except OSError:
            # It died between turns and stdin is gone. One fresh process, then give up.
            tail = " | ".join(list(brain.errbuf)[-3:]) if brain else ""
            with _BRAIN_LOCK:
                _discard(brain)
            if attempt == 2:
                raise RuntimeError(f"claude exited before it could take the question. {tail}"[:400])

    with _BRAIN_LOCK:
        _TURN = brain
    emitted_session = session_id
    last_usage = {}
    streamed_text = False       # partial deltas arrived -> ignore final text blocks
    text_seen = False
    first = True
    finished = False            # this turn's `result` arrived: the process is idle again
    last = time.monotonic()

    try:
        while True:
            line = brain.next_line()
            if line is None:
                if brain.eof.is_set():
                    line = brain.next_line()     # the pump may have queued one just before EOF
                    if line is None:
                        break
                else:
                    if time.monotonic() - last > IDLE_TIMEOUT:
                        brain.proc.kill()
                        yield dict(t="error", message=(
                            f"Claude went quiet for {IDLE_TIMEOUT}s and was stopped. "
                            + " | ".join(list(brain.errbuf)[-3:]))[:400])
                        return
                    time.sleep(0.01)
                    continue
            last = time.monotonic()
            line = line.strip()
            if not line or not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue

            kind = ev.get("type")
            sid = ev.get("session_id")
            if valid_session(sid):
                emitted_session = sid
                brain.session = str(sid)

            if kind == "system":
                if ev.get("subtype") == "init":
                    yield dict(t="status", model=ev.get("model") or MODEL or "Claude default",
                               tools=len(ev.get("tools") or []),
                               mcp=[s.get("name") for s in (ev.get("mcp_servers") or [])],
                               permission=ev.get("permissionMode") or PERMISSION,
                               session_id=sid, runtime="claude")
                continue

            if kind == "rate_limit_event":
                info = ev.get("rate_limit_info") or {}
                yield dict(t="ratelimit", status=info.get("status"),
                           window=info.get("rateLimitType"), resets=info.get("resetsAt"))
                continue

            if kind == "stream_event":
                inner = ev.get("event") or {}
                if inner.get("type") == "content_block_delta":
                    delta = inner.get("delta") or {}
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        if first:
                            first = False
                            yield dict(t="latency", ms=int((time.monotonic() - started) * 1000))
                        streamed_text = True
                        text_seen = True
                        yield dict(t="delta", text=delta["text"])
                continue

            if kind == "assistant":
                u = (ev.get("message") or {}).get("usage") or {}
                if u:
                    last_usage = u
                for block in (ev.get("message") or {}).get("content") or []:
                    btype = block.get("type")
                    if btype == "text" and not streamed_text and block.get("text"):
                        if first:
                            first = False
                            yield dict(t="latency", ms=int((time.monotonic() - started) * 1000))
                        text_seen = True
                        yield dict(t="delta", text=block["text"])
                    elif btype == "tool_use":
                        yield dict(t="tool", phase="use", name=block.get("name", "tool"),
                                   input=_short(block.get("input", "")))
                continue

            if kind == "user":
                for block in (ev.get("message") or {}).get("content") or []:
                    if block.get("type") == "tool_result":
                        yield dict(t="tool", phase="result",
                                   ok=not block.get("is_error"),
                                   name=block.get("name", ""))
                continue

            if kind == "result":
                usage = ev.get("usage") or last_usage or {}
                if ev.get("subtype") != "success" and not text_seen:
                    yield dict(t="error", message=str(ev.get("result") or "Claude returned an error")[:400])
                    return
                finished = True
                if not text_seen and ev.get("result"):
                    yield dict(t="delta", text=str(ev["result"]))
                    text_seen = True
                yield dict(t="usage",
                           input_tokens=usage.get("input_tokens", 0),
                           output_tokens=usage.get("output_tokens", 0),
                           total_tokens=(usage.get("input_tokens", 0) + usage.get("output_tokens", 0)))
                yield dict(t="complete", session_id=emitted_session,
                           ms=ev.get("duration_ms") or int((time.monotonic() - started) * 1000))
                return

        # stdout closed with no `result`: the process went away mid-turn.
        try:
            rc = brain.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            rc = None
        yield dict(t="error", message=(" | ".join(list(brain.errbuf)[-6:])
                                       or f"claude exited with code {rc}")[:500])
    finally:
        with _BRAIN_LOCK:
            if _TURN is brain:
                _TURN = None
            if not finished:
                _discard(brain)      # never reuse a process that stopped mid-turn


def run_mock(message, session_id=None, system=None):
    ok, detail = _can_launch()
    yield dict(t="error", message=("Claude Code is not reachable from this process. "
                                   "Install it, or set CLAUDE_CMD to the executable. "
                                   f"Diagnostic: {detail[:200]}"))


def run(message, session_id=None, system=None, context=None):
    if runtime_kind() != "claude":
        yield from run_mock(message, session_id, system)
        return
    try:
        yield from run_claude(message, session_id, system, context)
    except Exception as e:  # noqa: BLE001
        yield dict(t="error", message=f"could not start Claude core: {e}")
