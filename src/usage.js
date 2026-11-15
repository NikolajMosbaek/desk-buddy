import fs from 'node:fs';
import path from 'node:path';

// Counts today's tokens from Claude Code's local transcripts (~/.claude/projects/**/*.jsonl).
// This is the same raw data tools like ccusage read. It covers this machine only.
// Files are read incrementally: we remember how far into each file we've read.

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function emptyTotals() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0, byModel: {} };
}

export class UsageTracker {
  constructor(projectsDir) {
    this.dir = projectsDir;
    this.reset();
  }

  reset() {
    this.day = startOfToday();
    this.offsets = new Map(); // file -> bytes consumed
    this.partial = new Map(); // file -> trailing incomplete line
    this.seen = new Set();    // message.id:requestId, dedupes streamed duplicates
    this.totals = emptyTotals();
  }

  *_walk(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) yield* this._walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
    }
  }

  _ingestLine(line) {
    if (!line || line.indexOf('"usage"') === -1) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (o.type !== 'assistant' || !o.message?.usage) return;
    const ts = Date.parse(o.timestamp);
    if (!(ts >= this.day)) return;
    const key = `${o.message.id || ''}:${o.requestId || ''}`;
    if (key !== ':') {
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    const u = o.message.usage;
    const t = this.totals;
    const add = (k, v) => { if (typeof v === 'number') t[k] += v; };
    add('input', u.input_tokens);
    add('output', u.output_tokens);
    add('cacheWrite', u.cache_creation_input_tokens);
    add('cacheRead', u.cache_read_input_tokens);
    t.messages += 1;
    const model = o.message.model || 'unknown';
    if (model !== '<synthetic>') {
      t.byModel[model] = (t.byModel[model] || 0) + (u.input_tokens || 0) + (u.output_tokens || 0)
        + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    }
  }

  // Returns true if totals changed.
  refresh() {
    if (startOfToday() !== this.day) this.reset();
    const before = this.totals.messages;
    for (const file of this._walk(this.dir)) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < this.day) continue; // untouched today
      let off = this.offsets.get(file) || 0;
      if (st.size < off) off = 0; // file was rewritten
      if (st.size === off) continue;
      let buf;
      try {
        const fd = fs.openSync(file, 'r');
        buf = Buffer.alloc(st.size - off);
        fs.readSync(fd, buf, 0, buf.length, off);
        fs.closeSync(fd);
      } catch { continue; }
      this.offsets.set(file, st.size);
      const text = (this.partial.get(file) || '') + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial.set(file, lines.pop());
      for (const line of lines) this._ingestLine(line);
    }
    return this.totals.messages !== before;
  }

  snapshot() {
    const t = this.totals;
    return {
      day: this.day,
      input: t.input,
      output: t.output,
      cacheWrite: t.cacheWrite,
      cacheRead: t.cacheRead,
      total: t.input + t.output + t.cacheWrite + t.cacheRead,
      messages: t.messages,
      byModel: t.byModel,
    };
  }
}
