// "Today": a small summary of the day's work, shown instead of the token and
// context tiles while nothing is running. The server keeps the counts.
(() => {
  'use strict';
  const S = window.Settings;
  const B = window.DeskBuddy;
  const T = S.t({
    en: {
      title: 'Today', prompts: 'prompts', files: 'files', active: 'active', tokens: 'tokens',
      streak: (n) => `${n} day${n === 1 ? '' : 's'} in a row`,
      tests: (p, f) => (f ? `${p} test runs green, ${f} red` : `${p} test run${p === 1 ? '' : 's'} green`),
      commits: (n) => `${n} commit${n === 1 ? '' : 's'}`,
      pushes: (n) => `${n} push${n === 1 ? '' : 'es'}`,
      sessions: (n) => `${n} session${n === 1 ? '' : 's'}`,
      setting: 'Show summary of the day', settingHint: 'When Claude is not working',
    },
    da: {
      title: 'I dag', prompts: 'prompts', files: 'filer', active: 'aktiv', tokens: 'tokens',
      streak: (n) => `${n} ${n === 1 ? 'dag' : 'dage'} i træk`,
      tests: (p, f) => (f ? `${p} testkørsler grønne, ${f} røde` : `${p} ${p === 1 ? 'testkørsel' : 'testkørsler'} grøn${p === 1 ? '' : 'ne'}`),
      commits: (n) => `${n} commit${n === 1 ? '' : 's'}`,
      pushes: (n) => `${n} push`,
      sessions: (n) => `${n} ${n === 1 ? 'session' : 'sessioner'}`,
      setting: 'Vis dagens opsummering', settingHint: 'Når Claude ikke arbejder',
    },
  });
  S.define('today', true);

  const box = document.getElementById('today');
  document.getElementById('today-title').textContent = T.title;
  const grid = document.getElementById('today-grid');
  const sub = document.getElementById('today-sub');
  const streakEl = document.getElementById('today-streak');

  function cell(value, label) {
    const d = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = value;
    const s = document.createElement('span');
    s.textContent = label;
    d.append(b, s);
    return d;
  }

  let last = null;
  function render(st = last) {
    if (!st) return;
    last = st;
    const d = st.today;
    const quiet = st.mood === 'idle' || st.mood === 'sleeping';
    const show = Boolean(S.get('today') && quiet && d && d.prompts > 0);
    box.classList.toggle('hidden', !show);
    document.body.classList.toggle('show-today', show);
    if (!show) return;
    grid.replaceChildren(
      cell(String(d.prompts), T.prompts),
      cell(String(d.files), T.files),
      cell(B.fmtDuration(d.activeMs), T.active),
      cell(B.fmtTokens(st.usage?.total || 0), T.tokens),
    );
    const bits = [];
    if (d.testsPass || d.testsFail) bits.push(T.tests(d.testsPass, d.testsFail));
    if (d.commits) bits.push(T.commits(d.commits));
    if (d.pushes) bits.push(T.pushes(d.pushes));
    if (!bits.length && d.sessions) bits.push(T.sessions(d.sessions));
    sub.textContent = bits.join(' · ');
    sub.hidden = !bits.length;
    streakEl.textContent = st.streak > 1 ? T.streak(st.streak) : '';
  }

  document.addEventListener('buddy:state', (e) => render(e.detail));
  S.onChange((key) => { if (key === 'today') render(); });

  S.section('today', () => T.setting, (el) => {
    el.querySelector('h3').remove();
    el.appendChild(S.ui.toggle(T.setting, 'today', T.settingHint));
  });
})();
