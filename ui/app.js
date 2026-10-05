/* JARVIS · Claude Code memory HUD — front end.
   Talks to the local Python server over NDJSON. The brain is your `claude` CLI,
   so every token here is billed to your subscription, not an API key. */
'use strict';

var $ = function (s) { return document.querySelector(s); };
var TOKEN = document.querySelector('meta[name=jarvis-token]').content;
var headers = function (extra) {
  return Object.assign({ 'X-Jarvis-Token': TOKEN }, extra || {});
};
var esc = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
var now = function () { return new Date().toTimeString().slice(0, 8); };

var graph = null, hiddenTypes = new Set(), running = false, activeCtl = null;
var answerText = '', answerBubble = null, GRAPH = { nodes: [], links: [], hubs: [], counts: [] };

/* ── action log ───────────────────────────── */
function log(kind, label, msg) {
  var e = document.createElement('div');
  e.className = 'entry k-' + kind;
  e.innerHTML = '<div class="top"><span class="ts">' + now() + '</span>'
    + '<span class="kind">' + esc(label) + '</span></div>'
    + (msg ? '<div class="msg">' + esc(msg) + '</div>' : '');
  var box = $('#log');
  box.insertBefore(e, box.firstChild);
  while (box.children.length > 45) box.removeChild(box.lastChild);
}

/* Fish Audio reads [square brackets] as stage directions, never as words. We
   send the text through untouched so the model performs them, but on screen we
   render each tag as a chip so you can see the direction and hear the result.
   The browser speechSynthesis fallback has no such notion, so it gets a
   stripped copy — otherwise it literally reads "dry" out loud. */
var TONE_RE = /\[([^\][]{1,90})\]/g;

function stripTones(text) {
  return String(text || '').replace(TONE_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

function lastTone(text) {
  var found = null, m;
  TONE_RE.lastIndex = 0;
  while ((m = TONE_RE.exec(text)) !== null) found = m[1];
  return found;
}

function renderSpoken(el, text) {
  var html = '', last = 0, m;
  TONE_RE.lastIndex = 0;
  while ((m = TONE_RE.exec(text)) !== null) {
    html += esc(text.slice(last, m.index));
    html += '<span class="tone">' + esc(m[1]) + '</span>';
    last = m.index + m[0].length;
  }
  html += esc(text.slice(last));
  el.innerHTML = html;
}

function bubble(who, text) {
  var b = document.createElement('div');
  b.className = 'bubble ' + who;
  if (who === 'jarvis') renderSpoken(b, text); else b.textContent = text;
  $('#transcript').appendChild(b);
  var turns = $('#transcript').querySelectorAll('.bubble.me').length;
  $('#convoCount').textContent = turns + (turns === 1 ? ' turn' : ' turns');
  $('#convoBadge').textContent = turns;
  $('#btnConvo').classList.toggle('has', turns > 0);
  $('#transcript').scrollTop = $('#transcript').scrollHeight;
  return b;
}

/* The conversation panel is optional. Its icon in the ask bar opens it; the
   icon or the panel's own ✕ closes it. Turns keep collecting while it is shut,
   and the badge on the icon counts them. */
function setConvo(open) {
  document.body.classList.toggle('convo-open', open);
  var btn = $('#btnConvo'), label = open ? 'Hide conversation' : 'Show conversation';
  btn.classList.toggle('on', open);
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) $('#transcript').scrollTop = $('#transcript').scrollHeight;
}

function setVoiceState(state, cls) {
  $('#voiceState').textContent = state;
  $('#voiceDot').className = 'dot ' + (cls || '');
  document.body.classList.toggle('speaking', state === 'SPEAKING');   // the HUD's speaker moves on this
}

/* Hands each <audio> to the HUD so its speaker can follow the real level. */
function announceAudio(audio) {
  window.dispatchEvent(new CustomEvent('jarvis:audio', { detail: audio }));
}

/* ── panels ───────────────────────────────── */
function renderHubs() {
  $('#hubs').innerHTML = GRAPH.hubs.map(function (h) {
    return '<li data-id="' + esc(h.id) + '">'
      + '<i class="swatch" style="background:' + esc(h.colour) + '"></i>'
      + '<span class="nm">' + esc(h.title) + '</span>'
      + '<span class="ct">' + h.degree + '</span></li>';
  }).join('');
  Array.prototype.forEach.call($('#hubs').children, function (li) {
    li.onclick = function () { focusNode(li.dataset.id); };
  });
}

function renderFilter() {
  var colours = {};
  GRAPH.nodes.forEach(function (n) { colours[n.type] = n.colour; });
  $('#filter').innerHTML = GRAPH.counts.map(function (pair) {
    var t = pair[0], c = pair[1];
    return '<li data-type="' + esc(t) + '" class="' + (hiddenTypes.has(t) ? 'off' : '') + '">'
      + '<i class="swatch" style="background:' + esc(colours[t] || '#8fa3bf') + '"></i>'
      + '<span class="nm">' + esc(t.charAt(0).toUpperCase() + t.slice(1)) + '</span>'
      + '<span class="ct">' + c + '</span></li>';
  }).join('');
  Array.prototype.forEach.call($('#filter').children, function (li) {
    li.onclick = function () {
      var t = li.dataset.type;
      if (hiddenTypes.has(t)) hiddenTypes.delete(t); else hiddenTypes.add(t);
      graph.setFilter(hiddenTypes);
      renderFilter();
    };
  });
}

function renderInspector(node, trace) {
  var box = $('#inspector');
  if (!node) {
    box.innerHTML = '<p class="hint">Click a node to focus it — only that node and its '
      + 'connections light up, and you can read its note here. Shift-click a second node '
      + 'to trace the path.</p>';
    return;
  }
  var links = (graph.adj.get(node.id) || []).slice(0, 12);
  var html = '<div class="ititle">' + esc(node.title) + '</div>'
    + '<div class="imeta">' + esc(node.type) + ' · ' + node.degree + ' links'
    + (node.updated ? ' · ' + esc(node.updated) : '') + '</div>'
    + '<div class="ibody">' + esc(node.snippet || 'No body text.') + '</div>';
  if (trace && trace.length > 1) {
    html += '<div class="imeta" style="margin-top:10px">path · ' + trace.length + ' hops</div>'
      + '<div class="ibody">' + trace.map(function (id) {
        var n = graph.byId.get(id); return esc(n ? n.title : id);
      }).join(' → ') + '</div>';
  }
  if (links.length) {
    html += '<div class="ilinks">' + links.map(function (id) {
      var n = graph.byId.get(id);
      return '<span class="chip" data-id="' + esc(id) + '">' + esc(n ? n.title : id) + '</span>';
    }).join('') + '</div>';
  }
  box.innerHTML = html;
  Array.prototype.forEach.call(box.querySelectorAll('.chip'), function (c) {
    c.onclick = function () { focusNode(c.dataset.id); };
  });
}

function focusNode(id) {
  if (graph.setFocus(id, false)) {
    log('mem', 'MEMORY', 'focused ' + id);
  }
}

var MATRIX = [
  ['/recall', 'search vault'], ['/graph', 'reload memory'],
  ['/goal', 'objective'], ['/mission', 'queue'],
  ['/profile', 'remember'], ['/status', 'runtime'],
  ['/remember', 'save a memory'], ['/memory', 'what I know'],
  ['/new', 'fresh session'], ['/help', 'commands']
];
function renderMatrix() {
  $('#matrix').innerHTML = MATRIX.map(function (m) {
    return '<div class="mcell" data-cmd="' + m[0] + '"><b>' + m[0] + '</b><span>' + m[1] + '</span></div>';
  }).join('');
  Array.prototype.forEach.call($('#matrix').children, function (cell) {
    cell.onclick = function () {
      var cmd = cell.dataset.cmd;
      if (['/recall', '/goal', '/mission', '/profile', '/remember'].indexOf(cmd) >= 0) {
        $('#ask').value = cmd + ' ';
        $('#ask').focus();
      } else { transmit(cmd); }
    };
  });
}

/* ── data ─────────────────────────────────── */
async function loadGraph(force) {
  var res = await fetch('/api/graph' + (force ? '?force=1' : ''), { headers: headers() });
  GRAPH = await res.json();
  graph.setData(GRAPH);
  renderHubs(); renderFilter();
  $('#stageCount').textContent = GRAPH.total + ' notes · ' + GRAPH.links.length + ' links';
  $('#sVault').textContent = GRAPH.total + ' notes';
  setTimeout(function () { graph.fit(); }, 350);
}

async function loadStatus() {
  try {
    var s = await (await fetch('/api/status', { headers: headers() })).json();
    $('#pGateway').textContent = 'online :' + location.port;
    Account.version = s.runtime === 'claude' ? (s.version || 'Claude CLI') : null;
    Account.paint();
    $('#pVoice').textContent = s.server_voice ? 'Fish Audio' : 'browser';
    document.querySelectorAll('.pill .dot')[2].className = 'dot ' + (s.server_voice ? 'ok' : 'warn');
    $('#sModel').textContent = s.model;
    $('#cliBadge').textContent = s.runtime === 'claude' ? 'CLAUDE CLI' : 'CLI OFFLINE';
    window.__serverVoice = s.server_voice;
    window.__serverSTT = s.server_stt;
    $('#demoBadge').hidden = !s.demo;          // the scripted demo lines are switched on
    if (s.listener) $('#btnMic').title = 'Listening via ' + s.listener;
  } catch (e) { $('#pGateway').textContent = 'offline'; }
}

/* ── the run ──────────────────────────────── */
async function transmit(message, opts) {
  message = (message || '').trim();
  if (!message) return;
  if (running) { log('note', 'BUSY', 'still working — "' + message.slice(0, 36) + '" not sent'); return; }
  opts = opts || {};
  running = true;
  answerText = '';
  if (speech) speech.stop();                 // a new question cuts the old answer off
  var mine = speech = opts.speak === false ? null : new Spoken();
  Live.speaking = !!mine;                    // held until the last word has been heard
  document.body.classList.remove('boot');
  document.body.classList.add('running');
  if (graph) graph.setActivity(1);
  $('#toneNow').textContent = '—';
  setVoiceState('THINKING', 'hot');
  bubble('me', message);
  answerBubble = bubble('jarvis', '');
  answerBubble.classList.add('thinking');
  log('run', 'RUN', message.slice(0, 70));

  var t0 = performance.now();
  try {
    activeCtl = new AbortController();
    var res = await fetch('/api/run', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ message: message, fresh: /^\/new\b/.test(message) }),
      signal: activeCtl.signal
    });
    if (!res.ok) throw new Error('backend HTTP ' + res.status);
    var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleEvent(JSON.parse(line));
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') log('note', 'CANCEL', 'run cancelled');
    else { log('error', 'ERROR', String(e).slice(0, 160)); answerBubble.textContent = String(e).slice(0, 160); }
  }
  activeCtl = null;
  running = false;
  document.body.classList.remove('running');
  if (graph) graph.setActivity(0);
  answerBubble.classList.remove('thinking');
  $('#sLatency').textContent = Math.round(performance.now() - t0) + 'ms';
  if (mine) await mine.close();
  if (speech === mine) {
    speech = null;
    Live.speaking = false;
    setVoiceState(Live.on ? 'LISTENING' : 'IDLE', Live.on ? 'hot' : '');
  }
}

function handleEvent(ev) {
  switch (ev.t) {
    case 'status':
      if (ev.session_id) $('#sSession').textContent = ev.session_id.slice(0, 8);
      if (ev.model) $('#sModel').textContent = ev.model;
      log('ok', 'STATUS', 'claude online · tools=' + (ev.tools || 0)
        + ' · permission=' + (ev.permission || '—'));
      break;
    case 'latency':
      $('#sLatency').textContent = ev.ms + 'ms';
      log('note', 'LATENCY', 'first token after ' + ev.ms + 'ms');
      break;
    case 'tool':
      if (ev.phase === 'use') log('tool', 'TOOL', '→ ' + ev.name + '(' + (ev.input || '') + ')');
      else log('tool', 'TOOL', '✓ ' + (ev.ok === false ? 'error' : 'ok'));
      break;
    case 'focus':
      if (graph.setFocus(ev.id, false)) log('mem', 'MEMORY', 'vault hit → ' + ev.id);
      break;
    case 'graph':
      loadGraph(true);
      break;
    case 'memory':
      /* Long-term memory changed. A saved memory is a new note, so the graph
         is reloaded and the view goes to it: you see what was just kept. */
      if (ev.action === 'saved') log('mem', 'MEMORY', 'remembered · ' + ev.title);
      else if (ev.action === 'forgotten') log('mem', 'MEMORY', 'forgotten · ' + ev.title);
      else if (ev.action === 'known') log('mem', 'MEMORY', 'already held · ' + ev.title);
      else log('note', 'MEMORY', 'no memory matched “' + (ev.title || '') + '”');
      if (ev.action === 'saved' || ev.action === 'forgotten') {
        var wasFocused = graph.focus === ev.id;
        loadGraph(true).then(function () {
          if (ev.action === 'saved') graph.setFocus(ev.id, false);
          else if (wasFocused) graph.setFocus(null);     // its note is gone
        });
      }
      break;
    case 'delta':
      answerText += ev.text;
      if (speech) speech.feed(ev.text);
      renderSpoken(answerBubble, answerText);
      var tone = lastTone(answerText);
      if (tone) $('#toneNow').textContent = tone;
      $('#transcript').scrollTop = $('#transcript').scrollHeight;
      break;
    case 'usage':
      $('#sTokens').textContent = (ev.total_tokens || 0).toLocaleString();
      break;
    case 'ratelimit':
      $('#sLimit').textContent = (ev.status || '—') + (ev.window ? ' · ' + ev.window.replace('_', ' ') : '');
      break;
    case 'note':
      log('note', 'NOTE', ev.message || '');
      break;
    case 'error':
      log('error', 'ERROR', ev.message || '');
      answerBubble.textContent = ev.message || 'error';
      if (ev.login || /not logged in|\/login/i.test(ev.message || '')) {   // Claude is not connected
        Account.open();
        if (speech) speech.feed(ev.message + ' ');   // said aloud too: the question may have been spoken
      }
      break;
    case 'complete':
      if (ev.session_id) $('#sSession').textContent = String(ev.session_id).slice(0, 8);
      log('ok', 'DONE', (ev.ms || 0) + 'ms');
      break;
  }
}

/* ── voice ──────────────────────────────────
   Speech starts while Claude is still writing. Finished sentences go to
   /api/speak one piece at a time and the mp3 is played as it streams in, so the
   first words are heard about a second after they are written. Waiting for the
   whole reply and then for the whole clip cost ~25s of silence on a long answer. */
var FIRST_CUT = 50;    // chars before the first piece may be cut: low, so speech starts early
var NEXT_CUT = 160;    // later pieces are grouped into whole thoughts so Fish can phrase them
var PREROLL = 1.0;     // seconds of audio banked before playback starts (see Spoken.start)
var CAN_STREAM = !!(window.MediaSource && MediaSource.isTypeSupported('audio/mpeg'));
/* Tags that are a noise rather than a register. A register carries into the
   next piece; a sigh must not be repeated at the top of every sentence. */
var SOUND_TAG = /laugh|sigh|gasp|yawn|chuckl|cough|breath|break|pause|throat|sniff|groan|applau|audience/i;
var speech = null;     // the reply being spoken right now, if any

function playBlob(blob) {
  return new Promise(function (resolve) {
    var url = URL.createObjectURL(blob);
    var audio = new Audio(url);
    var done = function () { URL.revokeObjectURL(url); resolve(); };
    audio.onended = done;
    audio.onerror = done;
    announceAudio(audio);
    audio.play().catch(done);
  });
}

function browserSay(text) {
  return new Promise(function (resolve) {
    text = stripTones(text);
    if (!window.speechSynthesis || !text) return resolve();
    var u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02; u.pitch = 0.92;
    u.onend = resolve; u.onerror = resolve;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

/* The whole reply as one clip: the path for a browser that cannot play an mp3
   stream, and for no server voice at all. */
async function speakWhole(text) {
  if (!text) return;
  setVoiceState('SPEAKING', 'hot');
  if (window.__serverVoice) {
    try {
      var res = await fetch('/api/speak', {
        method: 'POST', headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ text: text })
      });
      if (res.ok) { await playBlob(await res.blob()); return; }
      log('note', 'VOICE', 'server voice failed, using browser');
    } catch (e) { log('note', 'VOICE', 'server voice unreachable, using browser'); }
  }
  await browserSay(text);
}

/* Where the next piece may end: a sentence end at or after `min` chars. Tags
   are masked first so punctuation inside one is never taken for a sentence
   end, and a tag still being written at the tail waits for its "]". */
function cutPoint(text, min) {
  var masked = text.replace(TONE_RE, function (m) { return new Array(m.length + 1).join('x'); });
  var open = masked.lastIndexOf('[');
  var limit = (open >= 0 && masked.length - open <= 91) ? open : masked.length;
  var re = /[.!?…]+["')”’]*\s+|\n+/g, m;
  while ((m = re.exec(masked)) !== null) {
    var end = m.index + m[0].length;
    if (end > limit) break;
    if (end >= min) return end;
  }
  return 0;
}

function appendAudio(sb, bytes) {
  return new Promise(function (resolve, reject) {
    var off = function () {
      sb.removeEventListener('updateend', ok);
      sb.removeEventListener('error', bad);
    };
    var ok = function () { off(); resolve(); };
    var bad = function () { off(); reject(new Error('audio append failed')); };
    sb.addEventListener('updateend', ok);
    sb.addEventListener('error', bad);
    try { sb.appendBuffer(bytes); } catch (e) { off(); reject(e); }
  });
}

/* One spoken reply. feed() it text as it streams, close() it when the text is
   complete. `done` resolves when the audio has actually FINISHED, not when it
   starts — live mode needs that to know when it is safe to listen again. */
function Spoken() {
  var s = this;
  s.stream = !!window.__serverVoice && CAN_STREAM;
  s.buf = '';          // written, not yet cut into a piece
  s.queue = [];        // pieces waiting for Fish
  s.rest = '';         // what the browser voice must finish if Fish fails midway
  s.pieces = 0;
  s.tone = null;       // last register tag, carried into pieces that open without one
  s.closed = false;    // no more text is coming
  s.busy = false;      // a piece is streaming
  s.failed = false;
  s.dead = false;      // stopped by Escape or by a newer question
  s.fed = false;       // some audio reached the player
  s.started = false;   // playback has begun
  s.audio = s.ms = s.sb = s.ctl = s.url = null;
  s.done = new Promise(function (resolve) { s.resolve = resolve; });
}

Spoken.prototype.feed = function (text) {
  this.buf += text;
  if (this.stream && !this.failed) this.cut(false);
};

Spoken.prototype.cut = function (flush) {
  for (;;) {
    var at = flush ? this.buf.length : cutPoint(this.buf, this.pieces ? NEXT_CUT : FIRST_CUT);
    if (at <= 0) return;
    var piece = this.buf.slice(0, at).trim();
    this.buf = this.buf.slice(at);
    if (/[\p{L}\p{N}]/u.test(stripTones(piece))) this.say(piece);
    if (flush) return;
  }
};

/* A piece that opens without its own tag inherits the register of the one
   before it, as it would have if the reply had been sent as a single clip. */
Spoken.prototype.say = function (piece) {
  var text = (!/^\[/.test(piece) && this.tone) ? '[' + this.tone + '] ' + piece : piece;
  var m;
  TONE_RE.lastIndex = 0;
  while ((m = TONE_RE.exec(piece)) !== null) if (!SOUND_TAG.test(m[1])) this.tone = m[1];
  this.pieces++;
  this.queue.push(text);
  this.pump();
};

/* One piece at a time, in order. Fish renders about twice as fast as the audio
   plays, so the next piece is buffered well before the current one runs out. */
Spoken.prototype.pump = async function () {
  if (this.busy) return;
  this.busy = true;
  while (!this.dead && !this.failed && this.queue.length) {
    var text = this.queue.shift();
    try { await this.pipe(text); }
    catch (e) {
      if (this.dead) break;
      this.failed = true;
      this.queue.unshift(text);
      log('note', 'VOICE', 'server voice failed, using browser');
    }
  }
  this.busy = false;
  this.end();
};

Spoken.prototype.pipe = async function (text) {
  this.ctl = new AbortController();
  var res = await fetch('/api/speak', {
    method: 'POST', headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ text: text }), signal: this.ctl.signal
  });
  if (!res.ok) throw new Error('speak HTTP ' + res.status);
  if (!this.audio) await this.open();
  var reader = res.body.getReader();
  for (;;) {
    var chunk = await reader.read();
    if (chunk.done) { if (this.fed) this.start(); return; }
    if (this.dead) { reader.cancel(); return; }
    await appendAudio(this.sb, chunk.value);
    this.fed = true;
    if (this.sb.buffered.length && this.sb.buffered.end(0) >= PREROLL) this.start();
  }
};

/* Fish sends audio in bursts, so playing from the very first frames runs the
   buffer dry about a second in and the voice stutters. Hold back until a
   second is banked, or the piece is complete if it is shorter than that. */
Spoken.prototype.start = function () {
  var s = this;
  if (s.started || s.dead) return;
  s.started = true;
  s.audio.play().catch(function () { s.finish(); });   // autoplay refused: nothing will sound
};

Spoken.prototype.open = function () {
  var s = this, ms = new MediaSource(), audio = new Audio();
  s.ms = ms; s.audio = audio;
  s.url = URL.createObjectURL(ms);
  audio.src = s.url;
  audio.onplaying = function () { if (!s.dead) setVoiceState('SPEAKING', 'hot'); };
  audio.onended = audio.onerror = function () { s.finish(); };
  announceAudio(audio);
  return new Promise(function (resolve, reject) {
    ms.addEventListener('sourceopen', function () {
      try { s.sb = ms.addSourceBuffer('audio/mpeg'); } catch (e) { return reject(e); }
      resolve();
    }, { once: true });
  });
};

/* Runs whenever the pump goes idle. Once no more text is coming, tell the
   player the clip is complete so `ended` can fire when playback gets there. */
Spoken.prototype.end = function () {
  if (!this.closed || this.busy || this.dead) return;
  if (this.failed) {
    this.rest = this.queue.join(' ') + ' ' + this.buf;
    this.queue = []; this.buf = '';
  }
  if (!this.fed) return this.finish();
  try { if (this.ms.readyState === 'open') this.ms.endOfStream(); }
  catch (e) { this.finish(); }
};

Spoken.prototype.finish = function () {
  var s = this, rest = s.rest;
  s.rest = '';
  if (rest && !s.dead) return browserSay(rest).then(function () { s.settle(); });
  s.settle();
};

Spoken.prototype.settle = function () {
  if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
  this.resolve();
};

Spoken.prototype.close = function () {
  var s = this;
  s.closed = true;
  if (s.dead) return s.done;
  if (!s.stream) {
    var text = s.buf.trim();
    s.buf = '';
    speakWhole(text).then(function () { s.settle(); });
    return s.done;
  }
  s.cut(true);
  s.end();
  return s.done;
};

Spoken.prototype.stop = function () {
  this.dead = true;
  this.queue = []; this.rest = '';
  if (this.ctl) this.ctl.abort();
  if (this.audio) this.audio.pause();
  if (window.speechSynthesis) speechSynthesis.cancel();
  this.settle();
};

/* ── live voice ───────────────────────────────
   Hold the mic open, watch the input level, and cut an utterance when you stop
   talking. No button press per turn.

   Two things this has to get right:
   - It must not hear JARVIS. Detection is suspended while a turn is running and
     while audio is playing, otherwise the reply gets transcribed as your next
     question and it talks to itself forever.
   - Room tone varies. The threshold is calibrated from your actual noise floor
     at start rather than hardcoded, so a noisy room does not trigger constantly. */
var SILENCE_MS = 950;      // quiet this long ends the utterance
var MIN_SPEECH_MS = 350;   // shorter than this is a cough, not a sentence
var MAX_SPEECH_MS = 20000; // hard stop so a stuck mic cannot record forever

var Live = {
  on: false, speaking: false, armed: false, sending: false,
  stream: null, ctx: null, analyser: null, data: null,
  recorder: null, chunks: [], raf: 0,
  threshold: 0.02, voiceStart: 0, lastVoice: 0,

  async enable() {
    if (Live.on) return;
    if (!window.__serverSTT) {
      log('error', 'VOICE', 'live mode needs server-side transcription — none available');
      return;
    }
    try {
      Live.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (e) {
      log('error', 'VOICE', 'microphone unavailable: ' + String(e).slice(0, 70));
      return;
    }
    Live.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (Live.ctx.state === 'suspended') await Live.ctx.resume();
    Live.analyser = Live.ctx.createAnalyser();
    Live.analyser.fftSize = 1024;
    Live.data = new Uint8Array(Live.analyser.fftSize);
    Live.ctx.createMediaStreamSource(Live.stream).connect(Live.analyser);

    Live.on = true;
    document.body.classList.add('live');
    $('#btnMic').classList.add('live');
    setVoiceState('CALIBRATING', 'hot');
    await Live.calibrate();
    setVoiceState('LISTENING', 'hot');
    log('ok', 'VOICE', 'live mode on — just talk, it sends when you stop');
    Live.loop();
  },

  /* Sample the room for a moment and sit above it. */
  calibrate() {
    return new Promise(function (resolve) {
      var samples = [], t0 = performance.now();
      (function tick() {
        if (!Live.on) return resolve();
        samples.push(Live.level());
        if (performance.now() - t0 < 700) return requestAnimationFrame(tick);
        samples.sort(function (a, b) { return a - b; });
        var floor = samples[Math.floor(samples.length / 2)] || 0.005;
        Live.threshold = Math.max(floor * 3.2, 0.015);
        log('note', 'VOICE', 'noise floor ' + floor.toFixed(4)
          + ' → threshold ' + Live.threshold.toFixed(4));
        resolve();
      })();
    });
  },

  level() {
    if (!Live.analyser) return 0;
    Live.analyser.getByteTimeDomainData(Live.data);
    var sum = 0;
    for (var i = 0; i < Live.data.length; i++) {
      var v = (Live.data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / Live.data.length);
  },

  meter(rms) {
    var pct = Math.min(100, Math.round((rms / (Live.threshold * 4)) * 100));
    var el = $('#vuFill');
    if (el) {
      el.style.width = pct + '%';
      el.className = Live.armed ? 'vufill hot' : 'vufill';
    }
  },

  loop() {
    if (!Live.on) return;
    Live.raf = requestAnimationFrame(Live.loop);
    // Never listen while we are thinking or talking.
    if (running || Live.speaking) {
      if (Live.armed) Live.discard();
      Live.meter(0);
      return;
    }
    var rms = Live.level();
    Live.meter(rms);
    var now = performance.now();
    if (rms > Live.threshold) Live.lastVoice = now;

    if (!Live.armed) {
      if (rms > Live.threshold) Live.start(now);
      return;
    }
    if (now - Live.voiceStart > MAX_SPEECH_MS) return Live.finish();
    if (now - Live.lastVoice > SILENCE_MS) {
      if (now - Live.voiceStart - SILENCE_MS > MIN_SPEECH_MS) Live.finish();
      else Live.discard();
    }
  },

  start(now) {
    try {
      Live.chunks = [];
      Live.recorder = new MediaRecorder(Live.stream);
      Live.recorder.ondataavailable = function (e) { if (e.data.size) Live.chunks.push(e.data); };
      Live.recorder.onstop = function () {
        var blob = new Blob(Live.chunks, { type: Live.recorder.mimeType || 'audio/webm' });
        if (Live.sending) { Live.sending = false; Live.send(blob); }
      };
      Live.recorder.start();
      Live.armed = true;
      Live.voiceStart = now;
      Live.lastVoice = now;
      setVoiceState('HEARING', 'hot');
    } catch (e) {
      log('error', 'VOICE', 'recorder failed: ' + String(e).slice(0, 60));
      Live.armed = false;
    }
  },

  finish() {
    Live.armed = false;
    Live.sending = true;
    setVoiceState('TRANSCRIBING', 'hot');
    try { Live.recorder.stop(); } catch (e) { Live.sending = false; }
  },

  discard() {
    Live.armed = false;
    Live.sending = false;
    try { if (Live.recorder && Live.recorder.state === 'recording') Live.recorder.stop(); } catch (e) {}
    setVoiceState(Live.on ? 'LISTENING' : 'IDLE', Live.on ? 'hot' : '');
  },

  async send(blob) {
    try {
      var res = await fetch('/api/listen', {
        method: 'POST',
        headers: headers({ 'content-type': blob.type || 'audio/webm' }),
        body: blob
      });
      var data = await res.json();
      var text = (data && data.text || '').trim();
      if (!res.ok || !text) {
        log('note', 'VOICE', 'nothing usable in that clip');
        setVoiceState('LISTENING', 'hot');
        return;
      }
      if (text.replace(/[^a-z0-9]/gi, '').length < 2) {   // "." / "[BLANK_AUDIO]"
        setVoiceState('LISTENING', 'hot');
        return;
      }
      log('note', 'VOICE', 'heard: "' + text + '"');
      await transmit(text);
      setVoiceState(Live.on ? 'LISTENING' : 'IDLE', Live.on ? 'hot' : '');
    } catch (e) {
      log('error', 'VOICE', 'transcription failed: ' + String(e).slice(0, 70));
      setVoiceState('LISTENING', 'hot');
    }
  },

  disable() {
    Live.on = false;
    Live.armed = false;
    cancelAnimationFrame(Live.raf);
    try { if (Live.recorder && Live.recorder.state === 'recording') Live.recorder.stop(); } catch (e) {}
    if (Live.stream) Live.stream.getTracks().forEach(function (t) { t.stop(); });
    if (Live.ctx) { try { Live.ctx.close(); } catch (e) {} }
    Live.stream = Live.ctx = Live.analyser = null;
    document.body.classList.remove('live');
    $('#btnMic').classList.remove('live');
    Live.meter(0);
    setVoiceState('IDLE', '');
    log('note', 'VOICE', 'live mode off');
  }
};

function setupMic() {
  $('#btnMic').onclick = function () {
    if (Live.on) Live.disable(); else Live.enable();
  };
}

/* ── Claude account ───────────────────────────
   JARVIS answers through the Claude Code CLI, on that CLI's own sign-in. This
   panel shows whether it is connected and runs the sign-in: the CLI opens the
   browser, you approve there, and the panel notices when it is done. */
var Account = {
  info: null, version: null, poll: 0,

  /* the Brain read-out in the header */
  paint: function () {
    var a = Account.info, label = Account.version || 'checking…', ok = true;
    if (a && a.installed === false) { label = 'not installed'; ok = false; }
    else if (a && !a.signed_in) { label = 'sign in'; ok = false; }
    else if (a) { label = 'Claude' + (a.plan ? ' · ' + a.plan : ''); }
    $('#pBrain').textContent = label;
    $('#brainDot').className = 'dot ' + (ok ? 'ok' : 'warn');
  },

  render: function () {
    var a = Account.info || {}, login = a.login || {};
    var state = $('#accountState'), hint = $('#accountHint'), btn = $('#btnSignIn'), link = $('#accountLink');
    $('#accountCode').hidden = !login.running;
    link.hidden = !(login.running && login.url);
    if (login.url) link.href = login.url;
    btn.hidden = !!login.running;
    btn.textContent = 'Sign in with Claude';
    btn.className = 'send';
    if (a.installed === false) {
      state.innerHTML = 'Claude Code is <b>not installed</b> on this Mac. JARVIS needs it to think.';
      hint.innerHTML = 'Paste this into Terminal, then reopen JARVIS:'
        + '<code>curl -fsSL https://claude.ai/install.sh | bash</code>';
      btn.hidden = true;
    } else if (login.running) {
      state.innerHTML = 'Waiting for you to <b>approve the sign-in</b> in your browser…';
      hint.textContent = login.refused
        ? 'That code was not accepted. Copy the whole code from the browser and try again.'
        : 'This panel updates by itself when you are done.';
    } else if (a.signed_in && a.method === 'claude.ai') {
      var plan = a.plan ? a.plan.charAt(0).toUpperCase() + a.plan.slice(1) + ' plan' : 'subscription';
      state.innerHTML = '<b>Connected</b> to your Claude ' + esc(plan) + '.';
      btn.textContent = 'Sign in again';
      btn.className = 'mic';
      hint.textContent = 'Use this to switch to a different Claude account.';
    } else if (a.signed_in) {
      state.innerHTML = /api|console/i.test(a.method || '')
        ? 'Connected with an <b>API key</b>, which is billed per use.'
        : '<b>Connected</b> to Claude.';
      hint.textContent = 'Sign in with your Claude subscription to use your plan instead.';
    } else {
      state.innerHTML = '<b>Not connected.</b> JARVIS answers through your Claude subscription.';
      hint.textContent = login.done && !login.ok
        ? 'That sign-in did not finish. Try again.'
        : 'Your browser will open. Approve the sign-in there.';
    }
  },

  refresh: async function () {
    try {
      Account.info = await (await fetch('/api/claude', { headers: headers() })).json();
    } catch (e) { return null; }
    Account.paint();
    Account.render();
    return Account.info;
  },

  open: function () { $('#account').hidden = false; Account.refresh(); },
  close: function () { $('#account').hidden = true; },

  signIn: async function () {
    var res = await fetch('/api/claude/login', {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}'
    });
    var data = await res.json();
    if (!res.ok) { $('#accountHint').textContent = data.error || 'Could not start the sign-in.'; return; }
    Account.info = Object.assign(Account.info || {}, { login: data.login });
    Account.render();
    log('note', 'CLAUDE', 'sign-in started — approve it in your browser');
    clearInterval(Account.poll);
    Account.poll = setInterval(Account.watch, 1500);
  },

  watch: async function () {
    var data;
    try { data = await (await fetch('/api/claude?login=1', { headers: headers() })).json(); }
    catch (e) { return; }
    Account.info = Object.assign(Account.info || {}, { login: data.login });
    if (data.login.running) { Account.render(); return; }
    clearInterval(Account.poll);
    await Account.refresh();
    log(data.login.ok ? 'ok' : 'error', 'CLAUDE', data.login.ok ? 'signed in' : 'sign-in did not finish');
  },

  /* some browsers end the sign-in by showing a code instead of returning */
  sendCode: function () {
    var code = $('#accountCodeInput').value.trim();
    if (!code) return;
    $('#accountCodeInput').value = '';
    fetch('/api/claude/code', {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ code: code })
    });
  },

  cancel: function () {
    fetch('/api/claude/cancel', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}' });
  }
};

function setupAccount() {
  var pill = $('#pillBrain');
  var toggle = function () { if ($('#account').hidden) Account.open(); else Account.close(); };
  pill.onclick = toggle;
  pill.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  $('#btnAccountClose').onclick = Account.close;
  $('#btnSignIn').onclick = Account.signIn;
  $('#btnAccountCode').onclick = Account.sendCode;
  $('#accountCodeInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') Account.sendCode(); });
  $('#btnAccountCancel').onclick = Account.cancel;
  // Someone opening JARVIS for the first time sees what is missing straight away.
  Account.refresh().then(function (a) { if (a && (a.installed === false || !a.signed_in)) Account.open(); });
}

/* ── boot ─────────────────────────────────── */
window.addEventListener('DOMContentLoaded', function () {
  graph = new MemoryGraph($('#graph'), {
    onSelect: function (node, trace) { renderInspector(node, trace); }
  });
  window.__jarvisGraph = graph;   // handy from devtools while tuning layout

  // dial ticks
  var ticks = '';
  for (var i = 0; i < 60; i++) {
    var a = (i / 60) * Math.PI * 2, r1 = 92, r2 = i % 5 === 0 ? 82 : 87;
    ticks += '<line x1="' + (100 + Math.cos(a) * r1).toFixed(1) + '" y1="' + (100 + Math.sin(a) * r1).toFixed(1)
      + '" x2="' + (100 + Math.cos(a) * r2).toFixed(1) + '" y2="' + (100 + Math.sin(a) * r2).toFixed(1)
      + '" stroke="rgba(95,228,255,' + (i % 5 === 0 ? '.35' : '.15') + ')" stroke-width="1"/>';
  }
  $('#ticks').innerHTML = ticks;

  renderMatrix();
  loadStatus();
  loadGraph(false);
  setupMic();
  setupAccount();
  setVoiceState('IDLE', '');

  $('#btnSend').onclick = function () { var v = $('#ask').value; $('#ask').value = ''; transmit(v); };
  $('#ask').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var v = $('#ask').value; $('#ask').value = ''; transmit(v); }
  });
  $('#btnConvo').onclick = function () { setConvo(!document.body.classList.contains('convo-open')); };
  $('#btnConvoClose').onclick = function () { setConvo(false); };
  $('#btnFit').onclick = function () { graph.fit(); };
  $('#btnLabels').onclick = function () {
    graph.showLabels = !graph.showLabels;
    $('#btnLabels').classList.toggle('on', graph.showLabels);
  };
  $('#btnDim').onclick = function () {
    graph.dim = !graph.dim;
    $('#btnDim').classList.toggle('on', graph.dim);
  };
  $('#btnLabels').classList.add('on');

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (activeCtl) activeCtl.abort();
      if (speech) speech.stop();
      fetch('/api/cancel', { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}' });
      graph.setFocus(null);
    }
    if (e.key === '/' && document.activeElement !== $('#ask')) { e.preventDefault(); $('#ask').focus(); }
  });

  setInterval(loadStatus, 20000);
  log('ok', 'BOOT', 'HUD online · claude code · local vault');
});
