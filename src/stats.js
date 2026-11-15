import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Per-day activity counters for the "Today" summary (and, later, levels and streaks).
// Stored in ~/.desk-buddy/stats.json. Only counts are kept: no prompts, no commands,
// and edited files only as short hashes for today, to count them once.

const ACTIVE_GAP_MS = 5 * 60_000; // events closer than this count as continuous work
const KEEP_DAYS = 400;
const SAVE_DELAY_MS = 5_000;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const emptyDay = () => ({
  prompts: 0, tools: 0, files: 0, sessions: 0, activeMs: 0,
  testsPass: 0, testsFail: 0, commits: 0, pushes: 0, firstAt: null, lastAt: null,
});

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url').slice(0, 10);

export class Stats {
  // file: where to persist, or null for in-memory only (demo mode and tests).
  constructor(file, { now = Date.now, log = () => {} } = {}) {
    this.file = file;
    this.now = now;
    this.log = log;
    this.data = { version: 1, days: {}, lifetime: { prompts: 0, tools: 0, files: 0, testsPass: 0, testsFail: 0, commits: 0, pushes: 0, since: null }, today: { date: null, files: [], sessions: [] }, lastEventAt: 0 };
    this.saveTimer = null;
    if (file) this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.version === 1 && raw.days && raw.lifetime) {
        this.data = { ...this.data, ...raw, lifetime: { ...this.data.lifetime, ...raw.lifetime }, today: { ...this.data.today, ...raw.today } };
      }
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`stats: ignoring unreadable ${this.file} (${e.message})`);
    }
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

  // ev: a hook payload. eventKind: what BuddyState spotted in it (testsPass, commit …), if anything.
  record(ev, eventKind = null) {
    if (!ev || typeof ev !== 'object') return;
    const t = this.now();
    const day = this._day(t);
    const life = this.data.lifetime;
    if (this.data.today.date !== dayKey(t)) this.data.today = { date: dayKey(t), files: [], sessions: [] };
    const today = this.data.today;
    const name = ev.hook_event_name;

    if (!life.since) life.since = t;
    if (!day.firstAt) day.firstAt = t;
    day.lastAt = t;
    const gap = t - (this.data.lastEventAt || 0);
    if (gap > 0 && gap < ACTIVE_GAP_MS) day.activeMs += gap;
    this.data.lastEventAt = t;

    const sid = ev.session_id && hash(ev.session_id);
    if (sid && name !== 'SessionEnd' && !today.sessions.includes(sid)) {
      today.sessions.push(sid);
      day.sessions += 1;
    }
    if (name === 'UserPromptSubmit') { day.prompts += 1; life.prompts += 1; }
    if (name === 'PreToolUse') { day.tools += 1; life.tools += 1; }
    if (name === 'PostToolUse' && EDIT_TOOLS.has(ev.tool_name)) {
      const f = ev.tool_input?.file_path || ev.tool_input?.notebook_path;
      if (f) {
        const h = hash(f);
        if (!today.files.includes(h)) { today.files.push(h); day.files += 1; life.files += 1; }
      }
    }
    const field = { testsPass: 'testsPass', testsFail: 'testsFail', commit: 'commits', push: 'pushes' }[eventKind];
    if (field) { day[field] += 1; life[field] += 1; }
    this._scheduleSave();
  }

  today() {
    const key = dayKey(this.now());
    return { date: key, ...(this.data.days[key] || emptyDay()) };
  }

  // Consecutive days with at least one prompt, ending today (or yesterday, so the
  // streak doesn't read 0 every morning before the first prompt).
  streak() {
    const has = (k) => (this.data.days[k]?.prompts || 0) > 0;
    let t = this.now();
    if (!has(dayKey(t))) t -= 86_400_000;
    let n = 0;
    // Step back a day at a time; noon avoids DST edges.
    const d = new Date(t);
    d.setHours(12, 0, 0, 0);
    while (has(dayKey(d.getTime())) && n <= KEEP_DAYS) { n += 1; d.setDate(d.getDate() - 1); }
    return n;
  }

  lifetime() { return { ...this.data.lifetime, activeDays: Object.values(this.data.days).filter((d) => d.prompts > 0).length }; }

  _scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  flush() {
    if (!this.file) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log(`stats: could not save (${e.message})`);
    }
  }
}
