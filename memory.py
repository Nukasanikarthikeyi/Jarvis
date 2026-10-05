"""
Obsidian-style memory vault -> knowledge graph.

Every .md file under vault/ is one node. Frontmatter gives it a type; wiki
links ([[Another Note]]) become edges. Nothing here is a database: the memory
IS a folder of markdown you can open in Obsidian, edit by hand, or let Claude
write to. That is the whole point — the graph on screen is the real filesystem,
not a decorative animation.

It is also where JARVIS keeps what it has been told to remember: each memory
is one more note, in vault/memory/, so it survives restarts, shows up in the
graph, and can be read, edited or deleted like any other file.
"""
import datetime
import os
import pathlib
import re
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent
# Where settings and data live: next to the code, or JARVIS_HOME (the Mac app
# sets it, so its own bundle is never written to).
DATA = pathlib.Path(os.path.expanduser(os.environ.get("JARVIS_HOME") or ROOT))
VAULT = pathlib.Path(os.path.expanduser(os.environ.get("JARVIS_VAULT") or DATA / "vault"))

WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")
FRONTMATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.S)

# Palette mirrors the filter legend: one colour per node type.
TYPE_COLOURS = {
    "call":     "#4c9bff",
    "note":     "#e9eff7",
    "concept":  "#ffb340",
    "project":  "#5f7cff",
    "person":   "#b98cff",
    "client":   "#2ed99b",
    "invoice":  "#ff6ba6",
    "proposal": "#ffa033",
    "sop":      "#ff8c42",
    "brief":    "#cbd6e4",
    "campaign": "#dfe8f3",
    "memory":   "#19e8f2",   # what JARVIS was told to remember: the HUD's own cyan
}
DEFAULT_COLOUR = "#8fa3bf"

_CACHE = {"at": 0.0, "data": None, "sig": None}
_LOCK = threading.Lock()
CACHE_TTL = 2.0


def _parse_frontmatter(text):
    meta, body = {}, text
    m = FRONTMATTER.match(text)
    if m:
        body = text[m.end():]
        for line in m.group(1).splitlines():
            if ":" in line and not line.strip().startswith("#"):
                k, _, v = line.partition(":")
                meta[k.strip().lower()] = v.strip().strip('"').strip("'")
    return meta, body


def _notes():
    """Every note in the vault. Dot-folders are not part of it: .trash holds
    forgotten memories (and, in a real Obsidian vault, deleted notes), and
    .obsidian is the app's own config."""
    if not VAULT.exists():
        return []
    return sorted(p for p in VAULT.rglob("*.md")
                  if not any(part.startswith(".") for part in p.relative_to(VAULT).parts))


def _signature():
    """Cheap change detector so the graph reloads when you edit the vault."""
    return tuple((str(p), int(p.stat().st_mtime)) for p in _notes())


def build_graph(force=False):
    with _LOCK:
        now = time.time()
        if not force and _CACHE["data"] and now - _CACHE["at"] < CACHE_TTL:
            return _CACHE["data"]
        sig = _signature()
        if not force and _CACHE["data"] and sig == _CACHE["sig"]:
            _CACHE["at"] = now
            return _CACHE["data"]

        nodes, by_title, edges = {}, {}, []
        if VAULT.exists():
            for path in _notes():
                try:
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                meta, body = _parse_frontmatter(text)
                title = meta.get("title") or path.stem
                ntype = (meta.get("type") or "note").strip().lower()
                key = title.lower()
                snippet = " ".join(
                    ln.strip() for ln in body.splitlines()
                    if ln.strip() and not ln.strip().startswith("#")
                )[:340]
                nodes[key] = dict(
                    id=key, title=title, type=ntype,
                    colour=TYPE_COLOURS.get(ntype, DEFAULT_COLOUR),
                    file=str(path.relative_to(VAULT)),
                    tags=[t.strip() for t in (meta.get("tags") or "").split(",") if t.strip()],
                    updated=meta.get("updated", ""),
                    snippet=snippet, degree=0,
                )
                by_title[key] = key
                for target in WIKILINK.findall(body):
                    edges.append((key, target.strip().lower()))

        # Keep only edges whose target actually exists; count degree both ways.
        clean, seen = [], set()
        for src, dst in edges:
            if dst not in by_title or src == dst:
                continue
            pair = tuple(sorted((src, dst)))
            if pair in seen:
                continue
            seen.add(pair)
            clean.append(dict(source=src, target=dst))
            nodes[src]["degree"] += 1
            nodes[dst]["degree"] += 1

        counts = {}
        for n in nodes.values():
            counts[n["type"]] = counts.get(n["type"], 0) + 1

        hubs = sorted(nodes.values(), key=lambda n: (-n["degree"], n["title"]))[:8]
        data = dict(
            nodes=list(nodes.values()),
            links=clean,
            counts=sorted(counts.items(), key=lambda kv: -kv[1]),
            hubs=[dict(id=h["id"], title=h["title"], degree=h["degree"],
                       colour=h["colour"], type=h["type"]) for h in hubs],
            vault=str(VAULT),
            total=len(nodes),
        )
        _CACHE.update(at=now, data=data, sig=sig)
        return data


def search(query, limit=6):
    """Plain substring recall over the vault, for the /recall command."""
    q = (query or "").strip().lower()
    if not q:
        return []
    hits = []
    for node in build_graph()["nodes"]:
        haystack = (node["title"] + " " + node["snippet"]).lower()
        if q in haystack:
            hits.append(node)
    hits.sort(key=lambda n: (-n["degree"], n["title"]))
    return hits[:limit]


def _scored(message):
    words = [w for w in re.split(r"[^a-z0-9]+", (message or "").lower()) if len(w) > 3]
    if not words:
        return []
    out = []
    for node in build_graph()["nodes"]:
        haystack = (node["title"] + " " + node["snippet"]).lower()
        score = sum(2 if w in node["title"].lower() else 1 for w in words if w in haystack)
        if score:
            out.append((score + node["degree"] * 0.1, node))
    out.sort(key=lambda pair: -pair[0])
    return out


def top_match(message):
    """The vault note a question most likely refers to, for graph focus."""
    hits = _scored(message)
    return hits[0][1]["id"] if hits else None


def context_for(message, limit=4):
    """Pull the most relevant vault notes so Claude answers from real memory."""
    scored = _scored(message)
    if not scored:
        return ""
    out = ["## Relevant memory from the JARVIS vault",
           "These notes come from the user's own markdown vault. Treat them as fact."]
    for _, node in scored[:limit]:
        out.append(f"### {node['title']} ({node['type']})\n{node['snippet']}")
    return "\n\n".join(out)


# ── long-term memory ─────────────────────────────────────────────
# What JARVIS has been told to remember. Each memory is an ordinary note of
# type `memory` in vault/memory/, linked to one hub note so they sit together in
# the graph, and linked to any vault note they mention.
MEM_DIR = VAULT / "memory"
TRASH = VAULT / ".trash"
HUB = "Long-term memory"
_MEM_LOCK = threading.Lock()
_LINK_SPAN = re.compile(r"(\[\[[^\]]*\]\])")
_STOP = {"the", "that", "this", "and", "for", "about", "what", "you", "your", "know", "with",
         "remember", "forget", "memory", "please", "jarvis", "operator", "are", "was", "has",
         "have"}


def _words(text):
    return {w for w in re.findall(r"[^\W_]+", (text or "").lower())
            if len(w) > 2 and w not in _STOP}


def _plain(text):
    """A memory as prose: wiki links unwrapped, the link back to the hub dropped."""
    text = (text or "").replace(f"[[{HUB}]]", " ")
    return " ".join(WIKILINK.sub(lambda m: m.group(1).strip(), text).split())


def memories():
    """What JARVIS has been told to remember, newest first."""
    out = []
    for n in build_graph()["nodes"]:
        if n["type"] != "memory":
            continue
        try:
            at = (VAULT / n["file"]).stat().st_mtime
        except OSError:
            at = 0
        out.append(dict(id=n["id"], title=n["title"], text=_plain(n["snippet"]),
                        file=n["file"], saved=n["updated"], at=at))
    out.sort(key=lambda m: -m["at"])
    return out


def memories_signature():
    """Changes whenever the memories do, so the server knows when Claude needs
    to be shown the list again."""
    return tuple(sorted((m["title"], m["text"]) for m in memories()))


def memories_block(limit=40):
    """The memories as Claude sees them."""
    held = memories()[:limit]
    if not held:
        return ""
    lines = [f"- {m['text']}" + (f" (saved {m['saved']})" if m["saved"] else "") for m in held]
    return ("## Long-term memory\nWhat the operator has asked you to remember, newest first. "
            "Treat it as things you know.\n" + "\n".join(lines))


def _link_known(fact):
    """Turn mentions of existing notes into wiki links, so a memory about
    Tom Rivers hangs off Tom Rivers in the graph."""
    titles = sorted((n["title"] for n in build_graph()["nodes"]
                     if n["type"] != "memory" and n["title"] != HUB and len(n["title"]) >= 4),
                    key=len, reverse=True)
    parts, linked = [fact], 0          # even slots are plain text, odd slots are links
    for title in titles:
        if linked >= 4:
            break
        mention = re.compile(r"(?<!\w)" + re.escape(title) + r"(?!\w)", re.I)
        for i in range(0, len(parts), 2):
            swapped, n = mention.subn(f"[[{title}]]", parts[i], count=1)
            if n:
                parts[i:i + 1] = _LINK_SPAN.split(swapped)
                linked += 1
                break
    return "".join(parts)


def _title(fact):
    words = re.sub(r'[\\/:*?"<>|#^\[\]]', " ", fact).split()
    return "Memory — " + " ".join(words[:8])[:60].rstrip(" .,;:!?—-")


def remember(text):
    """Save one fact. Returns (memory, created): a fact that is already held
    comes back as it is rather than being written a second time."""
    fact = " ".join(re.sub(r"\[\[|\]\]", "", str(text or "")).split())[:300].strip()
    if not re.search(r"[^\W_]", fact):
        raise ValueError("nothing to remember")
    with _MEM_LOCK:
        new = _words(fact)
        for m in memories():
            old = _words(m["text"])
            if fact.lower() == m["text"].lower() or (
                    new and old and len(new & old) / len(new | old) >= 0.8):
                return m, False

        today = datetime.date.today().isoformat()
        taken = {n["id"] for n in build_graph()["nodes"]}
        MEM_DIR.mkdir(parents=True, exist_ok=True)
        if HUB.lower() not in taken:
            (MEM_DIR / f"{HUB}.md").write_text(
                f"---\ntype: concept\nupdated: {today}\n---\n\n# {HUB}\n\n"
                "What JARVIS has been asked to remember. Each memory is its own note, "
                "linked back to this one.\n", encoding="utf-8")

        base = title = _title(fact)
        k = 2
        while title.lower() in taken or (MEM_DIR / f"{title}.md").exists():
            title, k = f"{base} ({k})", k + 1
        (MEM_DIR / f"{title}.md").write_text(
            f"---\ntype: memory\ncreated: {today}\nupdated: {today}\n---\n\n"
            f"# {title}\n\n{_link_known(fact)}\n\n[[{HUB}]]\n", encoding="utf-8")
        build_graph(force=True)
        return dict(id=title.lower(), title=title, text=fact, saved=today,
                    file=str(pathlib.Path("memory") / f"{title}.md")), True


def forget(query):
    """Drop the one memory this points at and return it; None when nothing
    matches, or when it is not clear which one is meant. The note is moved to
    the vault's .trash folder — where Obsidian also puts deleted notes — so it
    can be put back by hand."""
    q = " ".join(str(query or "").split()).lower()
    want = _words(q)
    with _MEM_LOCK:
        held = memories()
        pick = next((m for m in held if q and q in (m["text"].lower(), m["title"].lower())), None)
        if pick is None and want:
            scored = sorted(((len(want & _words(m["title"] + " " + m["text"])) / len(want), m)
                             for m in held), key=lambda s: -s[0])
            clear = len(scored) == 1 or (len(scored) > 1 and scored[1][0] < scored[0][0])
            if scored and scored[0][0] >= 0.6 and clear:
                pick = scored[0][1]
        if pick is None:
            return None
        src = VAULT / pick["file"]
        TRASH.mkdir(parents=True, exist_ok=True)
        dst, k = TRASH / src.name, 2
        while dst.exists():
            dst, k = TRASH / f"{src.stem} ({k}){src.suffix}", k + 1
        os.replace(src, dst)
        build_graph(force=True)
        return pick


class TagFilter:
    """Takes <remember>…</remember> and <forget>…</forget> out of Claude's reply
    as it streams, so the tags are never shown or spoken. feed() returns the
    text that may go on to the HUD and the tags this chunk completed."""
    TAGS = ("remember", "forget")

    def __init__(self):
        self.buf = ""       # text not yet released
        self.kind = None    # the tag we are inside, if any
        self.gap = ""       # trailing whitespace, held until we know what follows it

    def _release(self, text, tag_next=False):
        """Whitespace at the end waits: it is part of the reply only if more of
        the reply follows, not if the next thing is a tag or the end."""
        text = self.gap + text
        kept = text.rstrip()
        self.gap = "" if tag_next else text[len(kept):]
        return kept

    def feed(self, text):
        self.buf += text
        out, found = [], []
        while True:
            if self.kind:
                close = f"</{self.kind}>"
                end = self.buf.find(close)
                if end < 0:
                    break
                found.append((self.kind, " ".join(self.buf[:end].split())))
                self.buf, self.kind = self.buf[end + len(close):], None
                continue
            opens = [(self.buf.find(f"<{t}>"), t) for t in self.TAGS]
            opens = [(at, t) for at, t in opens if at >= 0]
            if opens:
                at, tag = min(opens)
                out.append(self._release(self.buf[:at], tag_next=True))
                self.buf, self.kind = self.buf[at + len(tag) + 2:], tag
                continue
            # No whole tag. Hold back a tail that could be the start of one.
            hold = 0
            for t in self.TAGS:
                opening = f"<{t}>"
                for n in range(min(len(opening) - 1, len(self.buf)), 0, -1):
                    if self.buf.endswith(opening[:n]):
                        hold = max(hold, n)
                        break
            cut = len(self.buf) - hold
            out.append(self._release(self.buf[:cut]))
            self.buf = self.buf[cut:]
            break
        return "".join(out), found

    def flush(self):
        """The reply is over. A tag the model never closed still counts."""
        text, found = "", []
        if self.kind:
            payload = " ".join(self.buf.split())
            if payload:
                found.append((self.kind, payload))
        else:
            text = self._release(self.buf, tag_next=True)
        self.buf, self.kind, self.gap = "", None, ""
        return text, found
