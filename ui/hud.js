/* JARVIS HUD dressing: the day strip, the ring gauges in the header, and the
   speaker in the voice dial. Nothing here talks to the server or changes what
   the HUD does — it reads the page that app.js keeps up to date and draws. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var CIRC = 2 * Math.PI * 39;              // length of a gauge arc (r = 39)

  function arc(el, share) {
    share = Math.max(0, Math.min(1, share || 0));
    el.style.strokeDasharray = (share * CIRC).toFixed(1) + ' ' + CIRC.toFixed(1);
  }

  /* ── date and clock ─────────────────────────── */
  function calendar() {
    var now = new Date(), day = now.getDate();
    var days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var html = '';
    for (var i = 1; i <= days; i++) {
      html += '<span' + (i === day ? ' class="today"' : '') + '>' + pad(i) + '</span>';
    }
    $('#dayStrip').innerHTML = html;
    $('#gMonth').textContent = now.toLocaleString(undefined, { month: 'short' });
    $('#gDay').textContent = pad(day);
    arc($('#gDateArc'), day / days);
    return day;
  }

  var today = calendar();
  function clock() {
    var now = new Date();
    $('#gClock').textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
    $('#gSec').textContent = pad(now.getSeconds());
    arc($('#gClockArc'), now.getSeconds() / 60);
    if (now.getDate() !== today) today = calendar();     // rolled past midnight
  }
  clock();
  setInterval(clock, 1000);

  /* ── telemetry rings ────────────────────────────
     app.js writes these numbers into the Action Log's stat grid. The rings
     mirror them, so they can never disagree with the grid. */
  function watch(sel, fn) {
    new MutationObserver(fn).observe($(sel), { childList: true, characterData: true, subtree: true });
    fn();
  }
  var digits = function (el) { return parseInt((el.textContent || '').replace(/\D/g, ''), 10); };

  function vault() {            // notes on screen, out of the whole vault
    var total = digits($('#sVault')), hidden = 0;
    if (isNaN(total)) return;
    Array.prototype.forEach.call(document.querySelectorAll('#filter li.off .ct'), function (c) {
      hidden += digits(c) || 0;
    });
    $('#gVault').textContent = total - hidden;
    arc($('#gVaultArc'), total ? (total - hidden) / total : 0);
  }
  function tokens() {           // last reply; a full ring is 1,000
    var n = digits($('#sTokens'));
    if (isNaN(n)) return;
    $('#gTokens').textContent = n >= 1000 ? (n / 1000).toFixed(1) + 'k' : n;
    arc($('#gTokensArc'), n / 1000);
  }
  function latency() {          // last reply; a full ring is 10 seconds
    var ms = digits($('#sLatency'));
    if (isNaN(ms)) return;
    $('#gLatency').textContent = (ms / 1000).toFixed(1) + 's';
    arc($('#gLatencyArc'), ms / 10000);
  }
  watch('#sVault', vault);
  watch('#filter', vault);
  watch('#sTokens', tokens);
  watch('#sLatency', latency);

  /* ── voice UI ───────────────────────────────────
     The speaker in the dial moves with JARVIS's own voice. app.js announces
     each <audio> it plays; the level comes from a capture of that element,
     which leaves the playback path itself alone. Where there is nothing to
     capture (Safari, the browser's built-in voice) the cone falls back to a
     synthetic throb, so it still moves whenever JARVIS is speaking. */
  var cone = $('#spkCone'), reactor = $('.reactor');
  var still = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var actx = null, analyser = null, samples = null, source = null;
  var level = 0, heard = false, silent = 0, looping = false;

  function tap(audio) {
    heard = false; silent = 0;
    if (!audio.captureStream) return;
    try {
      if (!actx) {
        actx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = actx.createAnalyser();
        analyser.fftSize = 512;
        samples = new Uint8Array(analyser.fftSize);
      }
      if (actx.state === 'suspended') actx.resume();
      var stream = audio.captureStream();
      if (!stream.getAudioTracks().length) return;
      if (source) source.disconnect();
      source = actx.createMediaStreamSource(stream);
      source.connect(analyser);
    } catch (e) { source = null; }
  }

  window.addEventListener('jarvis:audio', function (e) {
    var audio = e.detail;
    audio.addEventListener('playing', function () { tap(audio); }, { once: true });
  });

  function measured() {         // RMS of what is playing, or -1 if there is no usable tap
    if (!source || !actx || actx.state !== 'running') return -1;
    analyser.getByteTimeDomainData(samples);
    var sum = 0;
    for (var i = 0; i < samples.length; i++) {
      var v = (samples[i] - 128) / 128;
      sum += v * v;
    }
    var rms = Math.sqrt(sum / samples.length);
    if (rms > 0.01) { heard = true; silent = 0; } else { silent++; }
    // A tap that has given nothing for a second since it was attached is not working.
    return (!heard && silent > 60) ? -1 : rms;
  }

  function frame(t) {
    var speaking = document.body.classList.contains('speaking'), target = 0;
    if (speaking) {
      var rms = measured();
      // speech sits around 0.05–0.15 RMS; the gain puts that mid-scale
      target = rms >= 0 ? Math.min(1, rms * 6)
                        : 0.35 + 0.35 * Math.abs(Math.sin(t / 97) * Math.sin(t / 41));
    }
    level += (target - level) * (target > level ? 0.6 : 0.16);   // quick attack, soft release
    if (!speaking && level < 0.005) level = 0;

    // the cone pumps outward with the level and jitters a little: the vibration
    var shake = still ? 0 : level * 4;
    cone.style.transform = level
      ? 'translate(' + ((Math.random() - 0.5) * shake).toFixed(2) + 'px,'
        + ((Math.random() - 0.5) * shake).toFixed(2) + 'px) scale(' + (1 + level * 0.18).toFixed(3) + ')'
      : '';
    reactor.style.setProperty('--vox', level.toFixed(3));

    if (speaking || level) requestAnimationFrame(frame); else looping = false;
  }

  new MutationObserver(function () {
    if (!looping && document.body.classList.contains('speaking')) {
      looping = true;
      requestAnimationFrame(frame);
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();
