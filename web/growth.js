// The buddy grows with you: a level chip under it, hats it unlocks on the way, and a
// small party when it levels up. The server computes level, streak and unlocked hats.
(() => {
  'use strict';
  const S = window.Settings;
  const B = window.DeskBuddy;
  const T = S.t({
    en: {
      title: 'Hat', auto: 'Newest', none: 'None',
      hats: { party: 'Party hat', beanie: 'Beanie', headphones: 'Headphones', crown: 'Crown' },
      how: { party: 'Level 3', beanie: '3 days in a row', headphones: '50 commits', crown: 'Level 10' },
      chip: (lv) => `LV ${lv}`,
      levelUp: (lv) => `Level ${lv}!`,
      newHat: (name) => `New hat: ${name}!`,
      showLevel: 'Show level', showLevelHint: 'Grows with prompts, tests, commits and pushes',
    },
    da: {
      title: 'Hat', auto: 'Nyeste', none: 'Ingen',
      hats: { party: 'Festhat', beanie: 'Hue', headphones: 'Høretelefoner', crown: 'Krone' },
      how: { party: 'Level 3', beanie: '3 dage i træk', headphones: '50 commits', crown: 'Level 10' },
      chip: (lv) => `LV ${lv}`,
      levelUp: (lv) => `Level ${lv}!`,
      newHat: (name) => `Ny hat: ${name}!`,
      showLevel: 'Vis level', showLevelHint: 'Vokser med prompts, tests, commits og push',
    },
  });
  const ORDER = ['party', 'beanie', 'headphones', 'crown'];

  S.define('hat', 'auto'); // 'auto' | 'none' | a hat id
  S.define('showLevel', true);

  const chip = document.getElementById('level-chip');
  let g = null; // last growth from the server

  function wornHat() {
    const unlocked = g?.hats || [];
    const pick = S.get('hat');
    if (pick === 'none') return '';
    if (pick !== 'auto' && unlocked.includes(pick)) return pick;
    return ORDER.filter((h) => unlocked.includes(h)).pop() || '';
  }

  function render() {
    const hat = wornHat();
    if (hat) document.body.dataset.hat = hat; else delete document.body.dataset.hat;
    const show = Boolean(g && S.get('showLevel'));
    chip.classList.toggle('hidden', !show);
    if (!show) return;
    const span = Math.max(1, g.nextXp - g.levelXp);
    const pct = Math.min(100, Math.max(0, ((g.xp - g.levelXp) / span) * 100));
    chip.textContent = T.chip(g.level);
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${pct.toFixed(0)}%`;
    bar.appendChild(fill);
    chip.appendChild(bar);
  }

  document.addEventListener('buddy:state', (e) => {
    const next = e.detail.growth;
    if (!next) return;
    const prev = g;
    g = next;
    render();
    if (!prev) return; // first frame: nothing new to celebrate
    const newHats = next.hats.filter((h) => !prev.hats.includes(h));
    if (next.level <= prev.level && !newHats.length) return;
    if (document.body.dataset.mood === 'waiting') return; // don't drown out "needs you"
    const line = newHats.length ? T.newHat(T.hats[newHats[newHats.length - 1]]) : T.levelUp(next.level);
    // After the event reaction (tests, commit …) that usually comes in the same frame.
    setTimeout(() => {
      B.react('react-jump', line, { ms: 900, sayMs: 4000 });
      B.confetti();
      window.BuddySound?.play('done');
    }, 1600);
  });
  S.onChange((key) => { if (key === 'hat' || key === 'showLevel') render(); });

  S.section('hat', () => T.title, (el) => {
    const unlocked = g?.hats || [];
    const row = S.ui.choice('hat', [['auto', T.auto], ['none', T.none], ...ORDER.map((h) => [h, T.hats[h]])]);
    row.classList.add('hat-choice');
    row.querySelectorAll('button').forEach((b, i) => {
      const id = ['auto', 'none', ...ORDER][i];
      if (ORDER.includes(id) && !unlocked.includes(id)) {
        b.disabled = true;
        b.title = T.how[id];
        b.textContent = `${T.hats[id]}\n${T.how[id]}`;
      }
    });
    el.appendChild(row);
    el.appendChild(S.ui.toggle(T.showLevel, 'showLevel', T.showLevelHint));
  });
})();
