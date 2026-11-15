// Per-phone settings, stored in localStorage (each phone keeps its own preferences).
// Feature modules register a section in the settings sheet with Settings.section().
(() => {
  'use strict';

  const DEFAULTS = {
    sound: false,          // chimes for needs-you / done / error
    soundRepeat: true,     // remind again while still waiting
    blackout: 'night',     // 'never' | 'night' | 'asleep'
    nightFrom: 22,
    nightTo: 7,
    hat: 'auto',           // 'auto' (best unlocked) | 'none' | a hat id
  };

  let values = { ...DEFAULTS };
  try { Object.assign(values, JSON.parse(localStorage.getItem('settings') || '{}')); } catch { /* fresh */ }

  const listeners = new Set();
  const sections = [];

  const lang = (new URLSearchParams(location.search).get('lang') || navigator.language || 'en').slice(0, 2).toLowerCase();

  window.Settings = {
    lang,
    get: (key) => values[key],
    set(key, value) {
      values[key] = value;
      try { localStorage.setItem('settings', JSON.stringify(values)); } catch { /* private mode */ }
      for (const fn of listeners) fn(key, value);
    },
    onChange(fn) { listeners.add(fn); },
    // build(container) fills a fresh <section> each time the sheet opens.
    section(id, title, build) { sections.push({ id, title, build }); },
    t: (dict) => dict[lang] || dict.en,
  };

  document.addEventListener('buddy:settings-open', () => {
    const host = document.getElementById('settings-sections');
    host.textContent = '';
    for (const s of sections) {
      const el = document.createElement('section');
      el.className = 'settings-section';
      el.dataset.section = s.id;
      const h = document.createElement('h3');
      h.textContent = typeof s.title === 'function' ? s.title() : s.title;
      el.appendChild(h);
      s.build(el);
      host.appendChild(el);
    }
  });

  // Shared control builders so every section looks the same.
  window.Settings.ui = {
    toggle(label, key, hint) {
      const row = document.createElement('label');
      row.className = 'set-row';
      const text = document.createElement('span');
      text.textContent = label;
      if (hint) {
        const small = document.createElement('small');
        small.textContent = hint;
        text.appendChild(small);
      }
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(values[key]);
      input.addEventListener('change', () => window.Settings.set(key, input.checked));
      row.append(text, input);
      return row;
    },
    choice(key, options) {
      const row = document.createElement('div');
      row.className = 'set-choice';
      for (const [value, label] of options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.className = values[key] === value ? 'on' : '';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          window.Settings.set(key, value);
          row.querySelectorAll('button').forEach((x) => { x.className = x === b ? 'on' : ''; });
        });
        row.appendChild(b);
      }
      return row;
    },
    hourSelect(label, key) {
      const row = document.createElement('label');
      row.className = 'set-row';
      const text = document.createElement('span');
      text.textContent = label;
      const sel = document.createElement('select');
      for (let h = 0; h < 24; h++) {
        const o = document.createElement('option');
        o.value = String(h);
        o.textContent = `${String(h).padStart(2, '0')}:00`;
        if (h === Number(values[key])) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => window.Settings.set(key, Number(sel.value)));
      row.append(text, sel);
      return row;
    },
  };
})();
