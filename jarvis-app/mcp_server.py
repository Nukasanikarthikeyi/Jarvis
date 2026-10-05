"""
MCP server for the JARVIS vault.

Lets any MCP client — the "Jarvis - AI Assistant" desktop app, Claude Code,
Claude Desktop — search the vault and use JARVIS's long-term memory, the same
notes the HUD draws as its graph. Standard library only, like the rest of the
project, so there is nothing to install:

    python3 jarvis-app/mcp_server.py        speaks MCP over stdin/stdout

It reads the vault files directly, so it works whether or not the HUD server
is running.
"""
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent     # the project, one level up from jarvis-app/

# The HUD server takes JARVIS_VAULT from .env; follow it to the same vault.
_env = ROOT / ".env"
if _env.exists():
    for _line in _env.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line.startswith("JARVIS_VAULT=") and _line.partition("=")[2].strip():
            os.environ.setdefault("JARVIS_VAULT", _line.partition("=")[2].strip().strip('"').strip("'"))

sys.path.insert(0, str(ROOT))
import memory  # noqa: E402

NAME, VERSION = "jarvis-vault", "1.0.0"
DEFAULT_PROTOCOL = "2025-06-18"

INSTRUCTIONS = (
    "The operator's JARVIS vault: a folder of markdown notes about their clients, "
    "projects, calls, invoices and people, plus what they have asked JARVIS to "
    "remember. Search it before answering questions about their work or about "
    "themselves. Use memory_remember only when they ask for something to be "
    "remembered, and memory_forget only when they ask for it to be forgotten.")


def _text(schema_props, required=()):
    return {"type": "object", "properties": schema_props, "required": list(required),
            "additionalProperties": False}


TOOLS = [
    dict(name="vault_search",
         description="Search the JARVIS vault for notes relevant to a question or topic. "
                     "Returns the best-matching notes with their type and opening text.",
         inputSchema=_text({"query": {"type": "string", "description": "What to look for."},
                            "limit": {"type": "integer", "minimum": 1, "maximum": 10,
                                      "description": "How many notes to return (default 5)."}},
                           ["query"])),
    dict(name="vault_read",
         description="Read one vault note in full, by its title, with the notes it links to.",
         inputSchema=_text({"title": {"type": "string", "description": "The note's title."}},
                           ["title"])),
    dict(name="vault_overview",
         description="What the JARVIS vault holds: how many notes of each type, and the most "
                     "connected ones. A good first call when you do not know what is in there.",
         inputSchema=_text({})),
    dict(name="memory_list",
         description="Everything JARVIS has been asked to remember about the operator, newest first.",
         inputSchema=_text({})),
    dict(name="memory_remember",
         description="Save one lasting fact to JARVIS's long-term memory. Write a single sentence "
                     "that makes sense on its own, with names and real dates.",
         inputSchema=_text({"fact": {"type": "string", "description": "The fact, as one sentence."}},
                           ["fact"])),
    dict(name="memory_forget",
         description="Drop one memory from JARVIS's long-term memory. It is moved to the vault's "
                     ".trash folder, not destroyed.",
         inputSchema=_text({"memory": {"type": "string",
                                       "description": "The memory to drop, in its own words."}},
                           ["memory"])),
]


def _body(node):
    """A note's text without its frontmatter, or the heading that repeats its title."""
    raw = (memory.VAULT / node["file"]).read_text(encoding="utf-8", errors="replace")
    text = memory._parse_frontmatter(raw)[1].strip()
    first, _, rest = text.partition("\n")
    if first.lstrip("# ").strip().lower() == node["title"].lower():
        text = rest.strip()
    return text


def _neighbours(graph, node_id):
    titles = {n["id"]: n["title"] for n in graph["nodes"]}
    out = []
    for link in graph["links"]:
        if node_id in (link["source"], link["target"]):
            other = link["target"] if link["source"] == node_id else link["source"]
            out.append(titles.get(other, other))
    return sorted(set(out))


def vault_search(args):
    query = str(args.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    limit = max(1, min(int(args.get("limit") or 5), 10))
    hits = [node for _, node in memory._scored(query)[:limit]] or memory.search(query, limit)
    if not hits:
        return f"Nothing in the vault matches “{query}”."
    return "\n\n".join(f"## {n['title']} ({n['type']}, {n['degree']} links)\n{memory._plain(n['snippet'])}"
                       for n in hits)


def vault_read(args):
    wanted = " ".join(str(args.get("title") or "").split()).lower()
    if not wanted:
        raise ValueError("title is required")
    graph = memory.build_graph()
    node = next((n for n in graph["nodes"] if n["id"] == wanted), None)
    if node is None:
        close = [n for n in graph["nodes"] if wanted in n["id"]]
        if len(close) != 1:
            hint = ", ".join(n["title"] for n in close[:8]) or "none"
            return f"No note is titled “{args.get('title')}”. Close matches: {hint}."
        node = close[0]
    linked = _neighbours(graph, node["id"])
    text = _body(node)
    if len(text) > 6000:
        text = text[:6000].rstrip() + "\n… (note continues)"
    tail = f"\n\nLinked notes: {', '.join(linked)}" if linked else ""
    return f"# {node['title']} ({node['type']})\n\n{text}{tail}"


def vault_overview(_args):
    graph = memory.build_graph()
    kinds = ", ".join(f"{count} {kind}" for kind, count in graph["counts"])
    hubs = "\n".join(f"- {h['title']} ({h['type']}, {h['degree']} links)" for h in graph["hubs"])
    return (f"{graph['total']} notes and {len(graph['links'])} links.\nBy type: {kinds}.\n"
            f"Most connected:\n{hubs}")


def memory_list(_args):
    held = memory.memories()
    if not held:
        return "Nothing in long-term memory yet."
    return "\n".join(f"- {m['text']}" + (f" (saved {m['saved']})" if m["saved"] else "") for m in held)


def memory_remember(args):
    held, created = memory.remember(args.get("fact"))
    return (f"Saved: {held['text']}" if created else f"Already in memory: {held['text']}")


def memory_forget(args):
    gone = memory.forget(args.get("memory"))
    if gone is None:
        return ("No single memory matches that. Call memory_list to see what is held, then "
                "pass the memory in its own words.")
    return f"Forgotten: {gone['text']}"


HANDLERS = dict(vault_search=vault_search, vault_read=vault_read, vault_overview=vault_overview,
                memory_list=memory_list, memory_remember=memory_remember,
                memory_forget=memory_forget)


def handle(msg):
    """One JSON-RPC message in, one reply out (None for notifications)."""
    method, mid = msg.get("method"), msg.get("id")
    params = msg.get("params") or {}

    def ok(result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    if method == "initialize":
        asked = params.get("protocolVersion")
        return ok({"protocolVersion": asked if isinstance(asked, str) and asked else DEFAULT_PROTOCOL,
                   "capabilities": {"tools": {}},
                   "serverInfo": {"name": NAME, "version": VERSION},
                   "instructions": INSTRUCTIONS})
    if mid is None:
        return None                      # a notification: nothing to answer
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": TOOLS})
    if method == "tools/call":
        tool = HANDLERS.get(params.get("name"))
        if tool is None:
            return {"jsonrpc": "2.0", "id": mid,
                    "error": {"code": -32602, "message": f"unknown tool: {params.get('name')}"}}
        try:
            text, failed = tool(params.get("arguments") or {}), False
        except Exception as e:  # noqa: BLE001 — the model should see why, and can retry
            text, failed = f"{type(e).__name__}: {e}", True
        return ok({"content": [{"type": "text", "text": text}], "isError": failed})
    if method in ("resources/list", "prompts/list"):
        return ok({method.split("/")[0]: []})
    return {"jsonrpc": "2.0", "id": mid,
            "error": {"code": -32601, "message": f"method not found: {method}"}}


def main():
    # stdout carries the protocol and nothing else; anything to say goes to stderr.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        batch = msg if isinstance(msg, list) else [msg]
        for one in batch:
            reply = handle(one) if isinstance(one, dict) else None
            if reply is not None:
                sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
                sys.stdout.flush()


if __name__ == "__main__":
    main()
