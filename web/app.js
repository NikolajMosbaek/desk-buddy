(() => {
  'use strict';

  const STR = {
    en: {
      mood: {
        idle: 'Ready', thinking: 'Thinking…', working: 'Working', compacting: 'Tidying memory',
        waiting: 'Needs you', done: 'Done!', error: 'Oops', sleeping: 'Zzz',
      },
      verb: {
        run: 'Running', edit: 'Editing', write: 'Writing', read: 'Reading', search: 'Searching',
        browse: 'Browsing', delegate: 'Delegating', plan: 'Planning', tool: 'Using',
      },
      msg: { permission: 'Waiting for your permission', question: 'Has a question for you', 'your-turn': 'Your turn' },
      sleepingHint: 'No active Claude Code sessions',
      fiveHour: '5-hour limit', sevenDay: 'Weekly limit',
      resetsIn: (t) => `resets in ${t}`,
      limitsMissing: 'Live limits appear after the next Claude reply (needs the status line bridge and a Pro/Max plan).',
      today: 'Tokens today', context: 'Context',
      tokensDetail: (io, cache) => `${io} in/out · ${cache} cache`,
      ctxDetail: (proj) => proj,
      subagents: (n) => (n === 1 ? '1 subagent' : `${n} subagents`),
      offline: 'Lost connection to the computer',
      keepAwake: 'Keep screen on',
      pickTitle: 'Choose your buddy', pickDone: 'Done', pickButton: 'Buddy',
    },
    da: {
      mood: {
        idle: 'Klar', thinking: 'Tænker…', working: 'Arbejder', compacting: 'Rydder op',
        waiting: 'Har brug for dig', done: 'Færdig!', error: 'Ups', sleeping: 'Zzz',
      },
      verb: {
        run: 'Kører', edit: 'Redigerer', write: 'Skriver', read: 'Læser', search: 'Søger',
        browse: 'Browser', delegate: 'Uddelegerer', plan: 'Planlægger', tool: 'Bruger',
      },
      msg: { permission: 'Venter på din tilladelse', question: 'Har et spørgsmål til dig', 'your-turn': 'Din tur' },
      sleepingHint: 'Ingen aktive Claude Code-sessioner',
      fiveHour: '5-timers grænse', sevenDay: 'Ugentlig grænse',
      resetsIn: (t) => `nulstilles om ${t}`,
      limitsMissing: 'Live-grænser vises efter næste svar fra Claude (kræver status line-broen og Pro/Max).',
      today: 'Tokens i dag', context: 'Kontekst',
      tokensDetail: (io, cache) => `${io} ind/ud · ${cache} cache`,
      ctxDetail: (proj) => proj,
      subagents: (n) => (n === 1 ? '1 subagent' : `${n} subagents`),
      offline: 'Mistet forbindelsen til computeren',
      keepAwake: 'Hold skærmen tændt',
      pickTitle: 'Vælg din buddy', pickDone: 'Færdig', pickButton: 'Buddy',
    },
  };
  const params = new URLSearchParams(location.search);
  const lang = (params.get('lang') || navigator.language || 'en').slice(0, 2).toLowerCase();
  const T = STR[lang] || STR.en;

  const $ = (s) => document.querySelector(s);
  const body = document.body;

  // Keep the token in the URL so "Add to Home Screen" captures it.
  const token = window.BUDDY_TOKEN;
  if (token && params.get('t') !== token) {
    params.set('t', token);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }

  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = T[el.dataset.i18n]; });

  // ---------- formatting ----------
  const fmtTokens = (n) => {
    if (!n) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
    return String(n);
  };
  const fmtDuration = (ms) => {
    if (ms <= 0) return '0m';
    const m = Math.round(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const mm = m % 60;
    const hu = lang === 'da' ? 't' : 'h';
    if (d) return `${d}d ${h}${hu}`;
    if (h) return `${h}${hu} ${mm}m`;
    return `${mm}m`;
  };

  // ---------- rendering ----------
  let state = null;
  let lastMood = null;
  let clockSkew = 0;

  function activityText(s) {
    if (!s) return T.sleepingHint;
    if (s.mood === 'waiting') {
      const m = T.msg[s.message] || T.msg.permission;
      const a = !s.activity ? '' : s.activity.verb === 'say'
        ? ` · ${s.activity.detail}` : ` · ${T.verb[s.activity.verb] || ''} ${s.activity.detail || ''}`;
      return m + a;
    }
    if (s.mood === 'error' && s.message) return s.message;
    if (s.activity && (s.mood === 'working' || s.mood === 'thinking')) {
      let t = s.activity.verb === 'say'
        ? s.activity.detail
        : `${T.verb[s.activity.verb] || ''} ${s.activity.detail || ''}`.trim();
      if (s.subagents) t += ` · ${T.subagents(s.subagents)}`;
      return t;
    }
    if (s.message && T.msg[s.message]) return T.msg[s.message];
    if (s.subagents) return T.subagents(s.subagents);
    return '';
  }

  function renderMeter(el, w) {
    if (!w || typeof w.pct !== 'number') { el.classList.add('empty'); return false; }
    el.classList.remove('empty');
    const pct = Math.max(0, Math.min(100, w.pct));
    el.querySelector('.value').textContent = `${Math.round(w.pct)}%`;
    const fill = el.querySelector('.fill');
    fill.style.width = pct + '%';
    fill.classList.toggle('warn', pct >= 70 && pct < 90);
    fill.classList.toggle('bad', pct >= 90);
    const now = Date.now() + clockSkew;
    el.querySelector('.sub').textContent = w.resetsAt ? T.resetsIn(fmtDuration(w.resetsAt - now)) : '';
    return true;
  }

  function render() {
    if (!state) return;
    const mood = state.mood;
    $('#demo-badge').classList.toggle('hidden', !state.demo);
    if (mood !== lastMood) {
      body.dataset.mood = mood;
      if (mood === 'done' && lastMood !== null) confetti();
      if (lastMood !== null) moodLine(mood);
      lastMood = mood;
      applyTempo();
    }
    $('#mood-title').textContent = T.mood[mood] || mood;

    const f = state.focus;
    const act = $('#activity');
    act.textContent = '';
    const text = activityText(f);
    if (f && text && state.sessions.length > 1) {
      const p = document.createElement('span');
      p.className = 'proj';
      p.textContent = `${f.project} · `;
      act.appendChild(p);
    }
    act.appendChild(document.createTextNode(text));

    const l = state.limits || {};
    const a = renderMeter($('#m-5h'), l.fiveHour);
    const b = renderMeter($('#m-7d'), l.sevenDay);
    $('#limits-missing').textContent = a || b ? '' : T.limitsMissing;

    const u = state.usage || {};
    $('#tokens-today').textContent = fmtTokens(u.total || 0);
    $('#tokens-detail').textContent = T.tokensDetail(fmtTokens((u.input || 0) + (u.output || 0)), fmtTokens((u.cacheRead || 0) + (u.cacheWrite || 0)));

    const withCtx = [f, ...state.sessions].find((s) => s && s.context && typeof s.context.pct === 'number');
    $('#ctx').textContent = withCtx ? `${Math.round(withCtx.context.pct)}%` : '–';
    $('#ctx-detail').textContent = withCtx ? [withCtx.project, withCtx.model].filter(Boolean).join(' · ') : '';

    const ul = $('#sessions');
    ul.textContent = '';
    if (state.sessions.length > 1) {
      for (const s of state.sessions.slice(0, 6)) {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = `var(--mood-${s.mood}, var(--muted))`;
        li.append(dot, document.createTextNode(`${s.name || s.project} · ${T.mood[s.mood] || s.mood}`));
        ul.appendChild(li);
      }
    }
  }

  // Session chip colours mirror the mood colours.
  const moodColors = { idle: '#5fd4bf', thinking: '#8fb4ff', working: '#6cc7ff', compacting: '#b49cff', waiting: '#ffb547', done: '#7ee081', error: '#ff6b6b', sleeping: '#44505c' };
  for (const [k, v] of Object.entries(moodColors)) document.documentElement.style.setProperty(`--mood-${k}`, v);

  function confetti() {
    const box = $('#confetti');
    const colors = ['#7ee081', '#5fd4bf', '#ffb547', '#8fb4ff', '#ff9aa8'];
    for (let i = 0; i < 28; i++) {
      const el = document.createElement('i');
      const ang = Math.random() * Math.PI * 2;
      const dist = 80 + Math.random() * 140;
      el.style.setProperty('--c', colors[i % colors.length]);
      el.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
      el.style.setProperty('--dy', `${Math.sin(ang) * dist - 60}px`);
      el.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
      el.style.animationDelay = `${Math.random() * 0.15}s`;
      box.appendChild(el);
      setTimeout(() => el.remove(), 2000);
    }
  }

  // ---------- connection ----------
  let es = null;
  let offlineTimer = null;
  function setOffline(off) {
    clearTimeout(offlineTimer);
    if (off) {
      offlineTimer = setTimeout(() => {
        body.classList.add('offline');
        $('#conn-text').textContent = T.offline;
        $('#conn').classList.remove('hidden');
      }, 4000);
    } else {
      body.classList.remove('offline');
      $('#conn').classList.add('hidden');
    }
  }
  function connect() {
    if (es) es.close();
    es = new EventSource(`/events?t=${encodeURIComponent(token)}`);
    es.onmessage = (e) => {
      try {
        state = JSON.parse(e.data);
        clockSkew = state.serverTime - Date.now();
        setOffline(false);
        render();
      } catch { /* ignore malformed frame */ }
    };
    es.onerror = () => setOffline(true);
  }
  connect();
  // iOS freezes pages in the background; reconnect when we come back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { connect(); requestWakeLock(); }
  });
  setInterval(render, 30_000); // keep "resets in" countdowns fresh

  // ---------- buddies: look, tempo, personality ----------
  const BUDDIES = window.BUDDIES || {};
  const ids = Object.keys(BUDDIES);
  const storedBuddy = () => { try { return localStorage.getItem('buddy'); } catch { return null; } };
  let buddyId = [params.get('buddy'), storedBuddy(), 'pip'].find((b) => b && BUDDIES[b]) || ids[0];
  const buddy = () => BUDDIES[buddyId];
  const linesFor = (key) => {
    const l = buddy().lines;
    return (l[lang] || l.en)[key] || (l.en[key]) || [];
  };
  const pickLine = (key) => { const a = linesFor(key); return a[Math.floor(Math.random() * a.length)] || ''; };

  function applyTempo() {
    // Each buddy moves at its own pace: scale every running CSS animation on the character.
    requestAnimationFrame(() => {
      const rate = buddy().speed || 1;
      for (const a of document.getAnimations()) {
        const el = a.effect && a.effect.target;
        if (el && el.closest && el.closest('#buddy')) a.playbackRate = rate;
      }
    });
  }

  function setBuddy(id, { announce = false } = {}) {
    if (!BUDDIES[id]) return;
    buddyId = id;
    body.dataset.buddy = id;
    try { localStorage.setItem('buddy', id); } catch { /* private mode */ }
    params.set('buddy', id);
    history.replaceState(null, '', `${location.pathname}?${params}`);
    applyTempo();
    if (announce) say(pickLine('tap'));
  }

  const bubble = $('#bubble');
  let bubbleTimer = null;
  function say(text, ms = 3200) {
    if (!text) return;
    bubble.textContent = text;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
  }

  // Speak on mood changes, but don't chatter: routine moods at most every 12s.
  let lastSpoke = 0;
  function moodLine(mood) {
    const important = mood === 'waiting' || mood === 'done' || mood === 'error';
    if (!important && Date.now() - lastSpoke < 12_000) return;
    lastSpoke = Date.now();
    say(pickLine(mood), important ? 4500 : 3000);
  }

  // Tap the buddy: it reacts in character. Tap a lot and it gets dizzy.
  const REACTIONS = {
    pip: ['react-jump', 'react-wiggle', 'react-spin'],
    mochi: ['react-squish', 'react-squish', 'react-wiggle'],
    bolt: ['react-spin', 'react-jump', 'react-jump'],
    grumbles: ['react-huff', 'react-wiggle'],
  };
  const ALL_REACTIONS = ['react-jump', 'react-squish', 'react-spin', 'react-wiggle', 'react-dizzy', 'react-huff'];
  let taps = [];
  let reactTimer = null;
  function poke() {
    const now = Date.now();
    taps = taps.filter((t) => now - t < 2500);
    taps.push(now);
    const dizzy = taps.length >= 5;
    const list = REACTIONS[buddyId] || REACTIONS.pip;
    const cls = dizzy ? 'react-dizzy' : list[Math.floor(Math.random() * list.length)];
    body.classList.remove(...ALL_REACTIONS, 'tapped');
    void body.offsetWidth; // restart the animation if the same class comes twice
    body.classList.add(cls, 'tapped');
    applyTempo();
    say(pickLine(dizzy ? 'dizzy' : 'tap'), 2200);
    if (dizzy) taps = [];
    clearTimeout(reactTimer);
    reactTimer = setTimeout(() => body.classList.remove(...ALL_REACTIONS, 'tapped'), dizzy ? 1300 : 800);
  }
  $('#buddy').addEventListener('click', poke);

  // Picker
  const picker = $('#picker');
  $('#pick').textContent = T.pickButton;
  $('#picker-title').textContent = T.pickTitle;
  $('#picker-done').textContent = T.pickDone;
  function renderPicker() {
    const list = $('#picker-list');
    list.textContent = '';
    for (const id of ids) {
      const b = BUDDIES[id];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'pick-card' + (id === buddyId ? ' selected' : '');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.dataset.buddy = id;
      const txt = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = b.name;
      const tag = document.createElement('span');
      tag.className = 't';
      tag.textContent = b.tagline[lang] || b.tagline.en;
      txt.append(name, tag);
      card.append(sw, txt);
      card.addEventListener('click', (e) => { e.stopPropagation(); setBuddy(id, { announce: true }); renderPicker(); });
      list.appendChild(card);
    }
  }
  const SWATCH = { pip: '#3fb8a3', mochi: '#f2a7bd', bolt: '#f5c242', grumbles: '#8c7bd6' };
  const swatchStyle = document.createElement('style');
  swatchStyle.textContent = Object.entries(SWATCH).map(([k, v]) => `.swatch[data-buddy="${k}"]{background:${v}}`).join('');
  document.head.appendChild(swatchStyle);
  $('#pick').addEventListener('click', (e) => { e.stopPropagation(); renderPicker(); picker.classList.remove('hidden'); });
  $('#picker-done').addEventListener('click', (e) => { e.stopPropagation(); picker.classList.add('hidden'); });
  picker.addEventListener('click', (e) => { if (e.target === picker) picker.classList.add('hidden'); });

  setBuddy(buddyId);

  // ---------- keep the screen on ----------
  let lock = null;
  const wakeBtn = $('#wake');
  wakeBtn.textContent = T.keepAwake;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      lock = await navigator.wakeLock.request('screen');
      wakeBtn.classList.add('hidden');
      lock.addEventListener('release', () => { lock = null; });
    } catch {
      wakeBtn.classList.remove('hidden'); // needs a tap first
    }
  }
  wakeBtn.addEventListener('click', requestWakeLock);
  document.addEventListener('click', () => { if (!lock) requestWakeLock(); });
  requestWakeLock();

  // ---------- OLED care ----------
  // Nudge the whole layout a few pixels every couple of minutes so nothing sits still for hours.
  setInterval(() => {
    const dx = Math.round(Math.random() * 12 - 6);
    const dy = Math.round(Math.random() * 12 - 6);
    $('#stage').style.transform = `translate(${dx}px, ${dy}px)`;
  }, 120_000);
})();
