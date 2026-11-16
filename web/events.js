// One-off reactions to moments in a session: tests pass or fail, a commit, a push,
// and a scary command (rm -rf, force push, reset --hard …). The server spots them;
// this file only decides how the buddy reacts.
(() => {
  'use strict';
  const S = window.Settings;
  const B = window.DeskBuddy;
  const T = S.t({
    en: { toggle: 'React to tests, commits and pushes', hint: 'Also flinches at risky commands like force push' },
    da: { toggle: 'Reagér på tests, commits og push', hint: 'Krymper sig også ved risikable kommandoer som force push' },
  });
  S.define('events', true);

  // How each kind looks. `sound` is a chime name in sound.js (it respects the sound setting).
  const STYLE = {
    testsPass: { cls: 'react-jump', happy: true, ms: 900, sound: 'pass' },
    testsFail: { cls: 'react-slump', happy: false, ms: 1500, sound: 'error' },
    commit: { cls: 'react-spin', happy: true, ms: 900 },
    push: { cls: 'react-jump', happy: true, ms: 900, confetti: true, sound: 'pass' },
    scary: { cls: 'react-shock', happy: false, ms: 1300 },
  };
  const FRESH_MS = 20_000; // ignore events older than this (e.g. after a reload)

  let lastKey; // undefined until the first frame, so an old event never replays on load
  document.addEventListener('buddy:state', (e) => {
    const ev = e.detail.event;
    const key = ev ? `${ev.seq}:${ev.at}` : null; // `at` too: a server restart resets seq
    const first = lastKey === undefined;
    if (key === lastKey) return;
    lastKey = key;
    if (first || !ev || !S.get('events')) return;
    const age = (e.detail.serverTime || Date.now()) - ev.at;
    if (age > FRESH_MS) return;
    const st = STYLE[ev.kind];
    if (!st) return;
    // The focus session's waiting state matters more than a celebration from another session.
    if (document.body.dataset.mood === 'waiting' && ev.kind !== 'scary') return;
    B.react(st.cls, B.pickLine(ev.kind), { ms: st.ms, happy: st.happy, sayMs: 3500 });
    if (st.confetti) B.confetti();
    // A failed run usually also flips the mood to error, which already chimes.
    if (st.sound && !(st.sound === 'error' && document.body.dataset.mood === 'error')) window.BuddySound?.play(st.sound);
  });

  S.section('events', () => T.toggle, (el) => {
    el.querySelector('h3').remove(); // a single toggle needs no heading
    el.appendChild(S.ui.toggle(T.toggle, 'events', T.hint));
  });
})();
