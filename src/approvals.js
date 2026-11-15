import crypto from 'node:crypto';
import { describeTool } from './state.js';

// Approve from the phone (opt-in, `desk-buddy approvals on`).
//
// When Claude Code asks for permission, its PermissionRequest hook POSTs to us. If
// approvals are on and a phone is watching, we hold that request open for a short
// while and show Allow / Deny on the phone. The answer goes back as the hook's
// decision. If nobody answers in time, or you answer in the terminal, we reply with
// nothing and Claude Code carries on as if desk-buddy wasn't there.
//
// The phone talks plain HTTP on your network, so the page token alone must not be
// enough to approve anything. Each answer is signed with HMAC-SHA256 using an
// approval key that you type into the phone once. The key never travels over the
// network after that, and each request has its own random id, so a signed answer
// can't be replayed.

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
// How long a question waits for the phone. Capped below Node's 300 s request timeout.
export const waitSeconds = (v) => Math.max(10, Math.min(240, Math.round(Number(v)) || 60));
const MAX_FAILS = 5; // bad signatures per minute before approvals pause
const PAUSE_MS = 60_000;

// 16 characters from a 32-letter alphabet: 80 bits, typed once on the phone.
export function newApprovalKey() {
  const bytes = crypto.randomBytes(16);
  const s = Array.from(bytes, (b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('');
  return s.match(/.{4}/g).join('-');
}

// Typed keys are forgiving: case, dashes and spaces don't matter.
export const normaliseKey = (k) => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function sign(key, id, decision) {
  return crypto.createHmac('sha256', normaliseKey(key)).update(`${id}:${decision}`).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const sameInput = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class Approvals {
  // settings(): the current { enabled, key, waitSec } (read fresh, so `approvals on/off` needs no restart).
  constructor({ settings, onChange = () => {}, log = () => {}, now = Date.now }) {
    this.settings = settings;
    this.onChange = onChange;
    this.log = log;
    this.now = now;
    this.pending = new Map(); // id -> { id, ev, res, timer, createdAt, expiresAt }
    this.fails = [];
    this.pausedUntil = 0;
  }

  // Should this PermissionRequest wait for the phone?
  canHold(phones) {
    const s = this.settings();
    return Boolean(s.enabled && normaliseKey(s.key).length >= 16 && phones > 0 && this.now() >= this.pausedUntil);
  }

  // Keep the hook's HTTP response open until the phone answers, the terminal does, or time runs out.
  hold(ev, res) {
    const s = this.settings();
    const waitMs = waitSeconds(s.waitSec) * 1000;
    const id = crypto.randomBytes(12).toString('base64url');
    const p = { id, ev, res, createdAt: this.now(), expiresAt: this.now() + waitMs };
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

  // The phone's answer. Returns { ok } or { ok: false, status, error }.
  answer({ id, decision, mac }) {
    if (decision !== 'allow' && decision !== 'deny') return { ok: false, status: 400, error: 'bad decision' };
    if (this.now() < this.pausedUntil) return { ok: false, status: 429, error: 'paused after wrong keys' };
    const p = this.pending.get(id);
    const key = this.settings().key;
    if (!p) return { ok: false, status: 410, error: 'no longer waiting' };
    if (!key || !safeEqual(sign(key, id, decision), mac)) {
      const t = this.now();
      this.fails = this.fails.filter((f) => t - f < 60_000).concat(t);
      if (this.fails.length >= MAX_FAILS) {
        this.pausedUntil = t + PAUSE_MS;
        this.fails = [];
        this.log('approvals: too many wrong keys, paused for a minute');
        for (const pid of [...this.pending.keys()]) this._finish(pid, null, 'paused');
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
    const first = [...this.pending.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!first) return null;
    const ev = first.ev;
    const input = ev.tool_input || {};
    const act = describeTool(ev.tool_name, input) || { verb: 'tool', detail: ev.tool_name };
    const full = input.command || input.file_path || input.url || input.pattern || '';
    return {
      id: first.id,
      tool: ev.tool_name || '',
      verb: act.verb,
      summary: input.description ? String(input.description).slice(0, 120) : '',
      detail: String(full).slice(0, 400),
      project: ev.cwd ? String(ev.cwd).split(/[\\/]/).filter(Boolean).pop() : '',
      expiresAt: first.expiresAt,
      queued: this.pending.size,
    };
  }

  close() {
    for (const id of [...this.pending.keys()]) this._finish(id, null, 'shutdown');
  }
}
