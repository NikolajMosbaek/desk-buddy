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
    if (mood !== lastMood) {
      body.dataset.mood = mood;
      if (mood === 'done' && lastMood !== null) confetti();
      lastMood = mood;
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
