// Approve from the phone (opt-in: `desk-buddy approvals on` on the computer).
// When Claude asks for permission and the server holds the question for us, this shows
// Allow / Deny. Each answer is signed with the approval key typed in settings, so the
// page link alone can't approve anything. The terminal prompt keeps working as usual.
(() => {
  'use strict';
  const S = window.Settings;
  const T = S.t({
    en: {
      title: 'Approve from phone', key: 'Approval key', keyHint: 'Shown by `desk-buddy approvals on` on the computer',
      saved: 'Key saved on this phone.', notSet: 'No key yet: permission questions are answered in the terminal.',
      clear: 'Forget key', save: 'Save',
      asks: 'Claude asks to', allow: 'Allow', deny: 'Deny',
      verb: { run: 'run', edit: 'edit', write: 'write', read: 'read', search: 'search', browse: 'open', delegate: 'start an agent', plan: 'plan', tool: 'use', say: 'run' },
      left: (s) => `${s}s left, then the terminal decides`, more: (n) => `+${n - 1} more waiting`,
      noKey: 'Type the approval key in Settings to answer here.',
      wrong: 'Wrong approval key. Check Settings.', gone: 'Already answered in the terminal.', paused: 'Paused after wrong keys. Try again in a minute.', failed: 'Could not reach the computer.',
    },
    da: {
      title: 'Godkend fra telefonen', key: 'Godkendelsesnøgle', keyHint: 'Vises af `desk-buddy approvals on` på computeren',
      saved: 'Nøglen er gemt på denne telefon.', notSet: 'Ingen nøgle endnu: tilladelser besvares i terminalen.',
      clear: 'Glem nøgle', save: 'Gem',
      asks: 'Claude vil', allow: 'Tillad', deny: 'Afvis',
      verb: { run: 'køre', edit: 'redigere', write: 'skrive', read: 'læse', search: 'søge', browse: 'åbne', delegate: 'starte en agent', plan: 'planlægge', tool: 'bruge', say: 'køre' },
      left: (s) => `${s} s tilbage, så afgør terminalen`, more: (n) => `+${n - 1} mere venter`,
      noKey: 'Tast godkendelsesnøglen i Indstillinger for at svare her.',
      wrong: 'Forkert godkendelsesnøgle. Tjek Indstillinger.', gone: 'Allerede besvaret i terminalen.', paused: 'Sat på pause efter forkerte nøgler. Prøv igen om et minut.', failed: 'Kunne ikke nå computeren.',
    },
  });

  S.define('approveKey', '');
  const norm = (k) => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  // ---------- the question card ----------
  const card = document.createElement('div');
  card.id = 'approval';
  card.className = 'hidden';
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-labelledby', 'approval-title');
  card.innerHTML = `
    <div class="ap-head"><span id="approval-title"></span><span class="ap-project"></span></div>
    <div class="ap-summary"></div>
    <pre class="ap-detail"></pre>
    <div class="ap-msg" aria-live="polite"></div>
    <div class="ap-buttons"><button type="button" class="ap-deny"></button><button type="button" class="ap-allow"></button></div>
    <div class="ap-foot"><span class="ap-left"></span><span class="ap-more"></span></div>`;
  document.body.appendChild(card);
  const $ = (s) => card.querySelector(s);
  $('.ap-allow').textContent = T.allow;
  $('.ap-deny').textContent = T.deny;

  let current = null; // the question on screen
  let shownAt = 0;
  let serverSkew = 0;
  let busy = false;

  function setMsg(text) { $('.ap-msg').textContent = text || ''; }

  function tickLeft() {
    if (!current) return;
    const s = Math.max(0, Math.round((current.expiresAt - (Date.now() + serverSkew)) / 1000));
    $('.ap-left').textContent = T.left(s);
  }
  setInterval(tickLeft, 1000);

  function show(q) {
    const isNew = !current || current.id !== q.id;
    current = q;
    if (isNew) {
      shownAt = Date.now();
      busy = false;
      setMsg('');
      $('#approval-title').textContent = `${T.asks} ${T.verb[q.verb] || T.verb.tool}${q.verb === 'tool' ? ` ${q.tool}` : ''}`;
      $('.ap-project').textContent = q.project || '';
      $('.ap-summary').textContent = q.summary || '';
      $('.ap-summary').hidden = !q.summary;
      $('.ap-detail').textContent = q.detail || q.tool;
    }
    const hasKey = norm(S.get('approveKey')).length >= 16;
    $('.ap-buttons').hidden = !hasKey;
    if (!hasKey) setMsg(T.noKey);
    $('.ap-more').textContent = q.queued > 1 ? T.more(q.queued) : '';
    tickLeft();
    card.classList.remove('hidden');
  }

  function hide() {
    current = null;
    card.classList.add('hidden');
  }

  document.addEventListener('buddy:state', (e) => {
    serverSkew = (e.detail.serverTime || Date.now()) - Date.now();
    if (e.detail.approval) show(e.detail.approval); else hide();
  });
  S.onChange((key) => { if (key === 'approveKey' && current) { setMsg(''); show(current); } });
  document.addEventListener('buddy:offline', (e) => { if (e.detail.offline) hide(); });

  async function answer(decision) {
    if (!current || busy) return;
    // A tap meant for the buddy must not approve a command that just popped up.
    if (Date.now() - shownAt < 700) return;
    busy = true;
    const id = current.id;
    const mac = window.BuddyHMAC.hmacHex(norm(S.get('approveKey')), `${id}:${decision}`);
    try {
      const r = await fetch(`/api/approve?t=${encodeURIComponent(window.BUDDY_TOKEN || '')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision, mac }),
      });
      if (r.ok) { if (current && current.id === id) hide(); return; }
      setMsg({ 403: T.wrong, 410: T.gone, 429: T.paused }[r.status] || T.failed);
    } catch {
      setMsg(T.failed);
    }
    busy = false;
  }
  $('.ap-allow').addEventListener('click', (e) => { e.stopPropagation(); answer('allow'); });
  $('.ap-deny').addEventListener('click', (e) => { e.stopPropagation(); answer('deny'); });

  // ---------- settings ----------
  S.section('approve', () => T.title, (el) => {
    const row = document.createElement('div');
    row.className = 'set-row set-key';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'XXXX-XXXX-XXXX-XXXX';
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'characters');
    input.setAttribute('autocorrect', 'off');
    input.spellcheck = false;
    input.setAttribute('aria-label', T.key);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'set-button';
    row.append(input, btn);
    const note = document.createElement('p');
    note.className = 'note';
    const refresh = () => {
      const has = norm(S.get('approveKey')).length >= 16;
      input.value = '';
      input.hidden = has;
      btn.textContent = has ? T.clear : T.save;
      note.textContent = has ? T.saved : `${T.notSet} ${T.keyHint}.`;
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (norm(S.get('approveKey')).length >= 16) S.set('approveKey', '');
      else if (norm(input.value).length >= 16) S.set('approveKey', norm(input.value));
      else { input.focus(); return; }
      refresh();
    });
    refresh();
    el.append(row, note);
  });
})();
