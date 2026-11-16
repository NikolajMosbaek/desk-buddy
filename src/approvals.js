import crypto from 'node:crypto';
import { describeTool } from './state.js';

// Approve from the phone (opt-in, `desk-buddy approvals on`).
//
// When Claude Code asks for permission, its PermissionRequest hook POSTs to us. If
// approvals are on and a phone with the approval key is watching, we hold that
// request open for a short while and show Allow / Deny on the phone. The answer goes
// back as the hook's decision. If nobody answers in time, or you answer in the
// terminal, we reply with nothing and Claude Code carries on as if we weren't there.
//
// The phone talks plain HTTP on your network, so the page token alone must not be
// enough to approve anything. Each answer is signed with HMAC-SHA256 using an
// approval key that you type into the phone once. The key never travels over the
// network after that. The signature covers a random id per question and a digest of
// exactly what the phone showed, so it can't be replayed or moved to another command.
// It does not protect against an active attacker who can rewrite the page itself.

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
// How long a question waits for the phone. Short by default: depending on the Claude
// Code version, the terminal prompt may only appear once the hook has answered.
export const DEFAULT_WAIT = 20;
export const waitSeconds = (v) => Math.max(5, Math.min(240, Math.round(Number(v)) || DEFAULT_WAIT));
const MAX_FAILS = 5; // bad signatures per minute before approvals pause
const PAUSE_MS = 60_000;
const MAX_PENDING = 20;
const MAX_SHOWN = 4000; // a question with more than this to show is left to the terminal

// Tools we can show faithfully and answer with a bare allow/deny. Others (MCP tools,
// AskUserQuestion and ExitPlanMode, which need updatedInput) stay in the terminal.
const HOLDABLE = new Set(['Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']);

// 16 characters from a 32-letter alphabet: 80 bits, typed once on the phone.
export function newApprovalKey() {
  const bytes = crypto.randomBytes(16);
  const s = Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('');
  return s.match(/.{4}/g).join('-');
}

// Typed keys are forgiving: case, dashes and spaces don't matter.
export const normaliseKey = (k) => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
// What the phone signs: the question id, the answer, and a digest of what it displayed.
export const signedText = (id, decision, tool, detail) => `${id}:${decision}:${sha256hex(`${tool}\n${detail}`)}`;
export function sign(key, id, decision, tool, detail) {
  return crypto.createHmac('sha256', normaliseKey(key)).update(signedText(id, decision, tool, detail)).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const sameInput = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Everything the user needs to judge the call, in full. Never shortened: what you
// approve is what you saw.
export function describeForPhone(ev) {
  const input = ev.tool_input || {};
  switch (ev.tool_name) {
    case 'Bash': return String(input.command ?? '');
    case 'Write': return `${input.file_path}\n\n${input.content ?? ''}`;
    case 'Edit': return `${input.file_path}\n\n- ${input.old_string ?? ''}\n+ ${input.new_string ?? ''}`;
    case 'WebFetch': return `${input.url ?? ''}${input.prompt ? `\n\n${input.prompt}` : ''}`;
    case 'WebSearch': return String(input.query ?? '');
    default: return `${input.file_path || input.notebook_path || ''}\n\n${JSON.stringify(input, null, 1)}`;
  }
}

export class Approvals {
  // settings(): the current { enabled, key, waitSec } (read fresh, so `approvals on/off` needs no restart).
  constructor({ settings, onChange = () => {}, log = () => {}, now = Date.now }) {
    this.settings = settings;
    this.onChange = onChange;
    this.log = log;
    this.now = now;
    this.pending = new Map(); // id -> { id, ev, res, timer, createdAt, expiresAt, detail }
    this.fails = [];
    this.pausedUntil = 0;
  }

  _usable(s = this.settings()) {
    return Boolean(s.enabled && normaliseKey(s.key).length >= 16 && this.now() >= this.pausedUntil);
  }

  // Should this PermissionRequest wait for the phone?
  canHold(phones, ev = null) {
    if (!(phones > 0) || !this._usable() || this.pending.size >= MAX_PENDING) return false;
    if (!ev) return true;
    return HOLDABLE.has(ev.tool_name) && describeForPhone(ev).length <= MAX_SHOWN;
  }

  // Keep the hook's HTTP response open until the phone answers, the terminal does, or time runs out.
  hold(ev, res) {
    const waitMs = waitSeconds(this.settings().waitSec) * 1000;
    const id = crypto.randomBytes(12).toString('base64url');
    const p = { id, ev, res, createdAt: this.now(), expiresAt: this.now() + waitMs, detail: describeForPhone(ev) };
    p.timer = setTimeout(() => this._finish(id, null, 'timeout'), waitMs);
    // Claude Code drops the request when you answer in the terminal (or it gives up).
    res.on('close', () => { if (this.pending.has(id)) this._finish(id, null, 'closed'); });
    this.pending.set(id, p);
    this.onChange();
    return id;
  }

  _finish(id, decision, why) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    let body = '{}';
    if (decision) {
      body = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: decision === 'allow'
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: 'Denied from the desk-buddy phone.' },
        },
      });
    }
    if (!p.res.writableEnded && !p.res.destroyed) {
      p.res.writeHead(200, { 'Content-Type': 'application/json' });
      p.res.end(body);
    }
    if (why !== 'answered') this.log(`approval ${why}: left to the terminal`);
    this.onChange();
    return true;
  }

  releaseAll(why) {
    for (const id of [...this.pending.keys()]) this._finish(id, null, why);
  }

  // Called every second: approvals turned off (or paused) send open questions back.
  sweep() {
    if (this.pending.size && !this._usable()) this.releaseAll('approvals off');
  }

  // The phone's answer. Returns { ok } or { ok: false, status, error }.
  answer({ id, decision, mac } = {}) {
    if (decision !== 'allow' && decision !== 'deny') return { ok: false, status: 400, error: 'bad decision' };
    const s = this.settings();
    if (!s.enabled) return { ok: false, status: 410, error: 'approvals are off' };
    if (this.now() < this.pausedUntil) return { ok: false, status: 429, error: 'paused after wrong keys' };
    const p = this.pending.get(id);
    if (!p) return { ok: false, status: 410, error: 'no longer waiting' };
    if (!s.key || !safeEqual(sign(s.key, id, decision, p.ev.tool_name || '', p.detail), mac)) {
      const t = this.now();
      this.fails = this.fails.filter((f) => t - f < 60_000).concat(t);
      if (this.fails.length >= MAX_FAILS) {
        this.pausedUntil = t + PAUSE_MS;
        this.fails = [];
        this.log('approvals: too many wrong keys, paused for a minute');
        this.releaseAll('paused');
      }
      return { ok: false, status: 403, error: 'wrong approval key' };
    }
    this._finish(id, decision, 'answered');
    return { ok: true, sessionId: p.ev.session_id };
  }

  // Other hooks from the same session tell us the question was answered elsewhere.
  observe(ev) {
    if (!this.pending.size || !ev) return;
    const name = ev.hook_event_name;
    for (const p of [...this.pending.values()]) {
      if (p.ev.session_id !== ev.session_id) continue;
      const done = ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'].includes(name)
        || ((name === 'PostToolUse' || name === 'PostToolUseFailure') && ev.tool_name === p.ev.tool_name && sameInput(ev.tool_input, p.ev.tool_input))
        || (name === 'PostToolUseFailure' && ev.is_interrupt);
      if (done) this._finish(p.id, null, 'answered elsewhere');
    }
  }

  // What the phone shows: the oldest open question, with how many are queued.
  snapshot() {
    const list = [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt);
    const first = list[0];
    if (!first) return null;
    const ev = first.ev;
    const input = ev.tool_input || {};
    const act = describeTool(ev.tool_name, input) || { verb: 'tool', detail: ev.tool_name };
    return {
      id: first.id,
      tool: ev.tool_name || '',
      verb: act.verb === 'say' ? 'run' : act.verb,
      // Claude's own description of the call. Written by the model, so the phone labels it as such.
      claim: input.description ? String(input.description).slice(0, 160) : '',
      detail: first.detail,
      project: ev.cwd ? String(ev.cwd).split(/[\\/]/).filter(Boolean).pop() : '',
      expiresAt: first.expiresAt,
      queued: list.length,
    };
  }

  close() { this.releaseAll('shutdown'); }
}
