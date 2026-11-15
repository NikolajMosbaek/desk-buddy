// Night mode: a black screen when nothing needs you, so a phone that stays on all day
// costs almost no power and an OLED panel rests. It lights up again by itself when
// Claude starts working or needs you, and a tap peeks for a minute.
(() => {
  'use strict';
  const S = window.Settings;
  const T = S.t({
    en: {
      title: 'Black screen', never: 'Never', night: 'At night', asleep: 'When asleep',
      from: 'From', to: 'To', hint: 'Lights up again when Claude works or needs you. Tap to peek.',
    },
    da: {
      title: 'Sort skærm', never: 'Aldrig', night: 'Om natten', asleep: 'Når den sover',
      from: 'Fra', to: 'Til', hint: 'Tænder igen, når Claude arbejder eller har brug for dig. Tryk for at kigge.',
    },
  });

  const overlay = document.getElementById('night');
  const clock = document.getElementById('night-clock');
  let peekUntil = 0;
  let mood = 'sleeping';

  // Exported for tests via window: is `hour` inside [from, to) on a 24h clock that may wrap midnight?
  function inHours(hour, from, to) {
    if (from === to) return false;
    return from < to ? hour >= from && hour < to : hour >= from || hour < to;
  }
  window.NightMode = { inHours };

  function shouldBlackout(now = new Date()) {
    if (Date.now() < peekUntil) return false;
    if (!document.getElementById('picker').classList.contains('hidden')) return false; // settings open
    const quiet = mood === 'idle' || mood === 'sleeping';
    if (!quiet) return false;
    const mode = S.get('blackout');
    if (mode === 'asleep') return mood === 'sleeping';
    if (mode === 'night') return inHours(now.getHours(), Number(S.get('nightFrom')), Number(S.get('nightTo')));
    return false;
  }

  function update() {
    const on = shouldBlackout();
    overlay.classList.toggle('hidden', !on);
    document.body.classList.toggle('blackout', on);
    if (on) {
      const d = new Date();
      clock.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      // Wander so the few lit pixels never sit in one place.
      clock.style.left = `${10 + Math.random() * 70}%`;
      clock.style.top = `${10 + Math.random() * 75}%`;
    }
  }

  document.addEventListener('buddy:mood', (e) => { mood = e.detail.mood; update(); });
  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    peekUntil = Date.now() + 60_000;
    update();
    setTimeout(update, 60_500);
  });
  S.onChange(update);
  document.addEventListener('buddy:settings-close', update);
  setInterval(update, 60_000);

  S.section('night', T.title, (el) => {
    el.appendChild(S.ui.choice('blackout', [['never', T.never], ['night', T.night], ['asleep', T.asleep]]));
    el.appendChild(S.ui.hourSelect(T.from, 'nightFrom'));
    el.appendChild(S.ui.hourSelect(T.to, 'nightTo'));
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = T.hint;
    el.appendChild(p);
  });
})();
