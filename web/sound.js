// Chimes for the moments that matter: needs you, done, error.
// Synthesised with Web Audio (no audio files). Browsers only allow sound after a tap,
// so when sound is on but still locked, a small "tap to enable sound" pill shows.
(() => {
  'use strict';
  const S = window.Settings;
  const T = S.t({
    en: {
      title: 'Sound', on: 'Play sounds', onHint: 'Needs you, done and error',
      repeat: 'Remind me', repeatHint: 'Chime again after 1 and 3 minutes if Claude is still waiting',
      test: 'Test sound', unlock: 'Tap to enable sound',
    },
    da: {
      title: 'Lyd', on: 'Afspil lyde', onHint: 'Har brug for dig, færdig og fejl',
      repeat: 'Påmind mig', repeatHint: 'Ding igen efter 1 og 3 minutter, hvis Claude stadig venter',
      test: 'Test lyd', unlock: 'Tryk for at slå lyd til',
    },
  });

  S.define('sound', false);
  S.define('soundRepeat', true);

  let ctx = null;
  const pill = document.getElementById('sound-unlock');
  pill.textContent = T.unlock;

  function context() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      // A dedicated desk phone should chime even with the ring/silent switch on.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* older iOS */ }
      ctx = new AC();
      ctx.onstatechange = refreshPill;
    }
    return ctx;
  }

  function refreshPill() {
    const locked = S.get('sound') && (!ctx || ctx.state !== 'running');
    pill.classList.toggle('hidden', !locked);
  }

  // Any tap unlocks audio (must happen inside the gesture). Returns a promise that
  // settles once the context is running, or has given up.
  function unlock(force) {
    if (!S.get('sound') && force !== true) return Promise.resolve();
    const c = context();
    if (!c || c.state === 'running') return Promise.resolve();
    // iOS sometimes needs a real buffer started inside the gesture, not just resume().
    try {
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, 22050);
      src.connect(c.destination);
      src.start(0);
    } catch { /* not fatal */ }
    return c.resume().then(refreshPill, refreshPill);
  }
  document.addEventListener('click', unlock, true);
  document.addEventListener('touchend', unlock, true);
  // After lock, Siri or a call the context is suspended or "interrupted"; try to come back.
  const wake = () => { if (ctx && S.get('sound') && ctx.state !== 'running') ctx.resume().then(refreshPill, refreshPill); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
  window.addEventListener('pageshow', wake);

  // Each buddy sounds a little different: pitch and tempo follow its personality.
  const VOICE = {
    pip: { pitch: 1, tempo: 1, wave: 'sine' },
    mochi: { pitch: 0.75, tempo: 1.35, wave: 'sine' },
    bolt: { pitch: 1.3, tempo: 0.7, wave: 'triangle' },
    grumbles: { pitch: 0.7, tempo: 1.15, wave: 'triangle' },
  };

  function tone(c, freq, start, dur, { wave = 'sine', gain = 0.22 } = {}) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = wave;
    osc.frequency.value = freq;
    // Soft attack and an exponential tail, like a small bell.
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(c.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  const PATTERNS = {
    // [semitones from A4, start beat, length beats]
    waiting: [[7, 0, 1.6], [3, 0.45, 2.2]],
    pass: [[7, 0, 0.7], [12, 0.2, 1.3]],
    levelUp: [[0, 0, 0.5], [4, 0.15, 0.5], [7, 0.3, 0.5], [12, 0.45, 0.5], [16, 0.6, 1.4]],
    done: [[3, 0, 0.9], [7, 0.18, 0.9], [10, 0.36, 0.9], [15, 0.54, 1.6]],
    error: [[-2, 0, 0.9], [-7, 0.3, 1.4]],
  };

  function schedule(c, kind) {
    const v = VOICE[window.DeskBuddy?.buddyId] || VOICE.pip;
    const t0 = c.currentTime + 0.08; // a little lead so the first attack isn't clipped after a resume
    for (const [semi, at, len] of PATTERNS[kind] || []) {
      const f = 440 * Math.pow(2, semi / 12) * 2 * v.pitch; // one octave up: cuts through a room
      tone(c, f, t0 + at * 0.5 * v.tempo, len * 0.5 * v.tempo, { wave: v.wave, gain: kind === 'error' ? 0.18 : 0.22 });
    }
  }

  function play(kind, { force = false } = {}) {
    if (!S.get('sound') && !force) return;
    const c = ctx;
    if (!c) { refreshPill(); return; } // never unlocked by a tap yet
    if (c.state === 'running') { schedule(c, kind); return; }
    // Suspended or interrupted (lock screen, call, Siri): try to resume without a tap.
    // Only show the pill if it is still not running shortly after.
    c.resume().then(() => { if (c.state === 'running') schedule(c, kind); }, () => {});
    setTimeout(refreshPill, 500);
  }

  let reminders = [];
  const clearReminders = () => { reminders.forEach(clearTimeout); reminders = []; };

  function startReminders() {
    clearReminders();
    if (!S.get('sound') || !S.get('soundRepeat')) return;
    reminders = [60_000, 180_000].map((ms) => setTimeout(() => {
      if (document.body.dataset.mood === 'waiting') play('waiting');
    }, ms));
  }

  // "Needs you" is tracked per session, so a second session asking while the buddy is
  // already waiting still chimes and restarts the reminders.
  let waitingIds = null; // null until the first frame: don't chime for an old state
  document.addEventListener('buddy:state', (e) => {
    const ids = new Set((e.detail.sessions || []).filter((s) => s.mood === 'waiting').map((s) => s.id));
    const first = waitingIds === null;
    const fresh = !first && [...ids].some((id) => !waitingIds.has(id));
    waitingIds = ids;
    if (!ids.size) { clearReminders(); return; }
    if (fresh) play('waiting');
    if (fresh || first) startReminders(); // after a reload: no chime, but still remind
  });

  document.addEventListener('buddy:mood', (e) => {
    const { mood, prev } = e.detail;
    if (prev === null) return;
    if (mood === 'done') play('done');
    else if (mood === 'error') play('error');
  });

  S.onChange((key) => {
    if (key !== 'sound' && key !== 'soundRepeat') return;
    if (key === 'sound' && !S.get('sound') && ctx && ctx.state === 'running') {
      ctx.suspend().then(refreshPill, refreshPill); // release the phone's audio session
    }
    if (key === 'sound' && S.get('sound')) unlock();
    if (waitingIds && waitingIds.size) startReminders(); // also clears when turned off
    else clearReminders();
    refreshPill();
  });
  refreshPill();

  S.section('sound', T.title, (el) => {
    el.appendChild(S.ui.toggle(T.on, 'sound', T.onHint));
    el.appendChild(S.ui.toggle(T.repeat, 'soundRepeat', T.repeatHint));
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'set-button';
    b.textContent = T.test;
    b.addEventListener('click', (e) => { e.stopPropagation(); unlock(true).then(() => play('waiting', { force: true })); });
    el.appendChild(b);
  });

  window.BuddySound = { play };
})();
