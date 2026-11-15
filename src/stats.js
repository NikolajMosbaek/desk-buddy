import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Per-day activity counters for the "Today" summary, and lifetime counters for levels,
// streaks and hats. Stored in ~/.desk-buddy/stats.json (mode 600). Only counts are
// kept: no prompts, no commands, and files and sessions only as salted hashes for
// today, to count each once.

const ACTIVE_GAP_MS = 5 * 60_000; // events closer than this count as continuous work
const LONG_RUN_MS = 30 * 60_000; // a single tool call or reply may take this long
const KEEP_DAYS = 400;
const SAVE_DELAY_MS = 5_000;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// Events that mean Claude (or you) is actually working. Waiting on a permission
// prompt, idle notifications and session start/end are not.
const WORK = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop']);
const LONG_RUNNERS = new Set(['UserPromptSubmit', 'PreToolUse']);

export function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The day before `key`, via local noon so DST changes can't skip or repeat a day.
export function prevDayKey(key) {
  const d = new Date(`${key}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return dayKey(d.getTime());
}

const DAY_FIELDS = ['prompts', 'tools', 'files', 'sessions', 'activeMs', 'testsPass', 'testsFail', 'commits', 'pushes'];
const LIFE_FIELDS = [...DAY_FIELDS, 'activeDays', 'streak', 'bestStreak'];
const emptyDay = () => ({ ...Object.fromEntries(DAY_FIELDS.map((k) => [k, 0])), firstAt: null, lastAt: null });
const emptyLife = () => ({ ...Object.fromEntries(LIFE_FIELDS.map((k) => [k, 0])), since: null, lastActiveDay: null, hats: [] });
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

export class Stats {
  // file: where to persist, or null for in-memory only (demo mode and tests).
  constructor(file, { now = Date.now, log = () => {} } = {}) {
    this.file = file;
    this.now = now;
    this.log = log;
    this.data = { version: 1, salt: crypto.randomBytes(8).toString('hex'), days: {}, lifetime: emptyLife(), seen: { date: null, files: [], sessions: [] }, last: { at: 0, name: null } };
    this.saveTimer = null;
    this.readOnly = false;
    this.rev = 0; // bumped on every change, for callers that cache derived values
    if (file) this._load();
  }

  _load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') { this.log(`stats: cannot read ${this.file} (${e.message}); not saving`); this.readOnly = true; }
      return;
    }
    let raw = null;
    try { raw = JSON.parse(text); } catch { /* handled below */ }
    if (raw && typeof raw.version === 'number' && raw.version > 1) {
      // Written by a newer desk-buddy: use nothing, overwrite nothing.
      this.log(`stats: ${this.file} is from a newer version; not saving`);
      this.readOnly = true;
      return;
    }
    if (!raw || raw.version !== 1 || !raw.days || typeof raw.days !== 'object' || !raw.lifetime || typeof raw.lifetime !== 'object') {
      // Keep the broken file for the curious, and start over.
      const bad = `${this.file}.bad-${Date.now()}`;
      try { fs.renameSync(this.file, bad); } catch { /* best effort */ }
      this.log(`stats: ${this.file} was unreadable; moved it to ${bad}`);
      return;
    }
    this._adopt(raw);
  }

  // Take only well-formed values from disk, so a hand-edited file can't crash the server.
  _adopt(raw) {
    const d = this.data;
    if (typeof raw.salt === 'string' && raw.salt) d.salt = raw.salt;
    for (const [k, v] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== 'object') continue;
      const day = emptyDay();
      for (const f of DAY_FIELDS) day[f] = num(v[f]);
      day.firstAt = Number.isFinite(v.firstAt) ? v.firstAt : null;
      day.lastAt = Number.isFinite(v.lastAt) ? v.lastAt : null;
      d.days[k] = day;
    }
    const l = raw.lifetime;
    for (const f of LIFE_FIELDS) d.lifetime[f] = num(l[f]);
    d.lifetime.since = Number.isFinite(l.since) ? l.since : null;
    d.lifetime.lastActiveDay = typeof l.lastActiveDay === 'string' ? l.lastActiveDay : null;
    d.lifetime.hats = strings(l.hats);
    const s = raw.seen && typeof raw.seen === 'object' ? raw.seen : {};
    d.seen = { date: typeof s.date === 'string' ? s.date : null, files: strings(s.files), sessions: strings(s.sessions) };
    const last = raw.last && typeof raw.last === 'object' ? raw.last : {};
    d.last = { at: num(last.at), name: typeof last.name === 'string' ? last.name : null };
  }

  _hash(s) {
    return crypto.createHash('sha256').update(this.data.salt).update(String(s)).digest('base64url').slice(0, 10);
  }

  _day(t) {
    const key = dayKey(t);
    const d = this.data;
    if (!d.days[key]) {
      d.days[key] = emptyDay();
      const keys = Object.keys(d.days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete d.days[k];
    }
    return d.days[key];
  }

  _bump(day, field, n = 1) { day[field] += n; this.data.lifetime[field] += n; }

  // ev: a hook payload. eventKind: what BuddyState spotted in it (testsPass, commit …), if anything.
  record(ev, eventKind = null) {
    if (!ev || typeof ev !== 'object') return;
    const t = this.now();
    const key = dayKey(t);
    const day = this._day(t);
    const life = this.data.lifetime;
    if (this.data.seen.date !== key) this.data.seen = { date: key, files: [], sessions: [] };
    const seen = this.data.seen;
    const name = ev.hook_event_name;

    if (!life.since) life.since = t;
    if (!day.firstAt) day.firstAt = t;
    day.lastAt = t;

    // Active time: credit the gap since the previous event when both ends are work.
    // A reply or tool call that just started may legitimately run long (a build).
    const last = this.data.last;
    const gap = t - last.at;
    if (gap > 0 && WORK.has(name) && WORK.has(last.name)) {
      const cap = LONG_RUNNERS.has(last.name) ? LONG_RUN_MS : ACTIVE_GAP_MS;
      if (gap < cap) this._bump(day, 'activeMs', gap);
    }
    this.data.last = { at: t, name };

    if (name === 'UserPromptSubmit') {
      this._bump(day, 'prompts');
      const sid = ev.session_id && this._hash(ev.session_id);
      if (sid && !seen.sessions.includes(sid)) { seen.sessions.push(sid); this._bump(day, 'sessions'); }
      this._markActiveDay(key);
    }
    if (name === 'PreToolUse') this._bump(day, 'tools');
    if (name === 'PostToolUse' && EDIT_TOOLS.has(ev.tool_name)) {
      const f = ev.tool_input?.file_path || ev.tool_input?.notebook_path;
      if (f) {
        const h = this._hash(f);
        if (!seen.files.includes(h)) { seen.files.push(h); this._bump(day, 'files'); }
      }
    }
    const field = { testsPass: 'testsPass', testsFail: 'testsFail', commit: 'commits', push: 'pushes' }[eventKind];
    if (field) this._bump(day, field);
    this._changed();
  }

  // Streaks are kept incrementally in lifetime, so they outlive the pruning of old days.
  _markActiveDay(key) {
    const life = this.data.lifetime;
    if (life.lastActiveDay && key <= life.lastActiveDay) return; // same day, or the clock went back
    life.streak = life.lastActiveDay === prevDayKey(key) ? life.streak + 1 : 1;
    life.lastActiveDay = key;
    life.activeDays += 1;
    life.bestStreak = Math.max(life.bestStreak, life.streak);
  }

  today() {
    const key = dayKey(this.now());
    return { date: key, ...(this.data.days[key] || emptyDay()) };
  }

  // Consecutive active days ending today, or yesterday (so it doesn't read 0 every
  // morning before the first prompt).
  streak() {
    const life = this.data.lifetime;
    const today = dayKey(this.now());
    return life.lastActiveDay === today || life.lastActiveDay === prevDayKey(today) ? life.streak : 0;
  }

  bestStreak() { return this.data.lifetime.bestStreak; }

  // Lifetime counters (files and sessions are sums of each day's unique ones).
  lifetime() {
    const { hats, lastActiveDay, ...counts } = this.data.lifetime;
    return counts;
  }

  // Hats stay once earned, even if what earned them is later pruned.
  awardedHats() { return [...this.data.lifetime.hats]; }
  award(hats) {
    const have = this.data.lifetime.hats;
    const fresh = hats.filter((h) => !have.includes(h));
    if (!fresh.length) return;
    have.push(...fresh);
    this._changed();
  }

  _changed() {
    this.rev += 1;
    if (!this.file || this.readOnly || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.file || this.readOnly) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(this.data));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log(`stats: could not save (${e.message})`);
    }
  }
}
