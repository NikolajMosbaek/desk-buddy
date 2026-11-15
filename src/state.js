import path from 'node:path';
import { classifyCommand, testOutputFailed } from './events.js';

// Moods, most urgent first. The phone shows the most urgent mood across all sessions.
export const MOOD_PRIORITY = ['waiting', 'error', 'working', 'thinking', 'compacting', 'done', 'idle', 'sleeping'];

const DONE_MS = 6_000;          // celebrate this long after Stop, then idle
const OOPS_MS = 3_000;          // brief "ouch" after a failed tool call
const STALE_BUSY_MS = 10 * 60_000; // busy with no events this long: assume the session died
const SLEEP_MS = 15 * 60_000;    // idle this long: buddy falls asleep
const FORGET_MS = 12 * 60 * 60_000; // drop sessions with no events for 12h

function shorten(s, n = 60) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function base(p) {
  return p ? path.basename(String(p)) : '';
}

// Turn a tool call into a short human label. Kept deliberately terse: it is read from a metre away.
export function describeTool(name, input = {}) {
  if (!name) return null;
  input = input || {};
  switch (name) {
    case 'Bash':
    case 'BashOutput':
      // Claude's own description ("Run unit tests") reads better than a verb + raw command.
      if (input.description) return { verb: 'say', detail: shorten(input.description, 48) };
      return { verb: 'run', detail: shorten(input.command, 48) };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'edit', detail: base(input.file_path || input.notebook_path) };
    case 'Write':
      return { verb: 'write', detail: base(input.file_path) };
    case 'Read':
      return { verb: 'read', detail: base(input.file_path) };
    case 'Grep':
    case 'Glob':
    case 'LS':
      return { verb: 'search', detail: shorten(input.pattern || input.path, 40) };
    case 'WebFetch':
    case 'WebSearch':
      return { verb: 'browse', detail: shorten(input.query || hostOf(input.url), 40) };
    case 'Task':
    case 'Agent':
      return { verb: 'delegate', detail: shorten(input.description || input.subagent_type, 40) };
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { verb: 'plan', detail: '' };
    default: {
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
      if (mcp) return { verb: 'tool', detail: `${mcp[1]} · ${mcp[2]}` };
      return { verb: 'tool', detail: name };
    }
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

export class BuddyState {
  constructor() {
    this.sessions = new Map();
    this.limits = null; // last rate_limits seen via the status line bridge
    this.lastEventAt = 0;
    this.event = null; // last noteworthy moment (tests, commit, push, scary command) for a one-off reaction
    this.eventSeq = 0;
  }

  _event(kind, s, detail = null) {
    this.event = { seq: ++this.eventSeq, kind, at: Date.now(), session: s.id, project: s.project, detail };
  }

  // Tests, commits, pushes and scary commands get their own reaction on the phone.
  _bashEvent(name, ev, s) {
    if (ev.tool_name !== 'Bash') return;
    const cmd = ev.tool_input?.command;
    const kind = classifyCommand(cmd);
    if (!kind) return;
    const detail = shorten(cmd, 48);
    if (name === 'PreToolUse') {
      if (kind === 'scary') this._event('scary', s, detail);
    } else if (name === 'PostToolUse') {
      if (kind === 'test') this._event(testOutputFailed(ev.tool_response) ? 'testsFail' : 'testsPass', s, detail);
      else if (kind === 'commit' || kind === 'push') this._event(kind, s, detail);
    } else if (name === 'PostToolUseFailure' && !ev.is_interrupt) {
      if (kind === 'test') this._event('testsFail', s, detail);
    }
  }

  _session(id, cwd) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        project: base(cwd) || 'session',
        mood: 'idle',
        activity: null,
        message: null,
        subagents: 0,
        tools: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        moodUntil: 0,
        afterMood: null,
        context: null,
        cost: null,
        model: null,
      };
      this.sessions.set(id, s);
    }
    if (cwd) s.project = base(cwd);
    return s;
  }

  _setMood(s, mood, { activity = s.activity, message = null, ttl = 0, after = null } = {}) {
    s.mood = mood;
    s.activity = activity;
    s.message = message;
    s.moodUntil = ttl ? Date.now() + ttl : 0;
    s.afterMood = after;
  }

  // Apply one hook payload. Returns true if anything visible changed.
  applyHook(ev) {
    if (!ev || typeof ev !== 'object') return false;
    const name = ev.hook_event_name;
    const id = ev.session_id || 'unknown';
    const now = Date.now();
    this.lastEventAt = now;

    if (name === 'SessionEnd') {
      return this.sessions.delete(id);
    }

    const s = this._session(id, ev.cwd);
    s.updatedAt = now;
    // Hooks fired inside a subagent carry agent_id; they keep the parent busy but don't change its label much.
    const inSubagent = Boolean(ev.agent_id);
    this._bashEvent(name, ev, s);

    switch (name) {
      case 'SessionStart':
        this._setMood(s, 'idle', { activity: null });
        break;
      case 'UserPromptSubmit':
        s.tools = 0;
        this._setMood(s, 'thinking', { activity: null });
        break;
      case 'PreToolUse': {
        s.tools += 1;
        const act = describeTool(ev.tool_name, ev.tool_input);
        if (inSubagent && act) act.sub = true;
        this._setMood(s, 'working', { activity: act });
        break;
      }
      case 'PostToolUse':
      case 'PostToolBatch':
        if (s.mood === 'waiting' || s.mood === 'working') this._setMood(s, 'thinking');
        break;
      case 'PostToolUseFailure':
        if (ev.is_interrupt) {
          this._setMood(s, 'idle', { activity: null });
        } else {
          this._setMood(s, 'error', { message: shorten(ev.error, 80), ttl: OOPS_MS, after: 'thinking' });
        }
        break;
      case 'PermissionRequest':
        this._setMood(s, 'waiting', {
          activity: describeTool(ev.tool_name, ev.tool_input),
          message: 'permission',
        });
        break;
      case 'Notification':
        if (ev.notification_type === 'permission_prompt') {
          this._setMood(s, 'waiting', { message: 'permission' });
        } else if (ev.notification_type === 'idle_prompt') {
          // Claude has been waiting for the next prompt for a while. Not urgent: stay idle, but note it.
          if (s.mood !== 'waiting') this._setMood(s, 'idle', { activity: null, message: 'your-turn' });
        } else if (ev.notification_type === 'elicitation_dialog') {
          this._setMood(s, 'waiting', { message: 'question' });
        }
        break;
      case 'Elicitation':
        this._setMood(s, 'waiting', { message: 'question' });
        break;
      case 'ElicitationResult':
        this._setMood(s, 'thinking');
        break;
      case 'SubagentStart':
        s.subagents += 1;
        break;
      case 'SubagentStop':
        s.subagents = Math.max(0, s.subagents - 1);
        break;
      case 'PreCompact':
        this._setMood(s, 'compacting', { activity: null });
        break;
      case 'PostCompact':
        this._setMood(s, s.tools ? 'thinking' : 'idle');
        break;
      case 'Stop':
        s.subagents = 0;
        this._setMood(s, 'done', { activity: null, ttl: DONE_MS, after: 'idle' });
        break;
      case 'StopFailure':
        s.subagents = 0;
        this._setMood(s, 'error', {
          activity: null,
          message: shorten(ev.last_assistant_message || ev.error, 80),
        });
        break;
      default:
        return false;
    }
    return true;
  }

  // Status line payloads: rate limits, context and cost. Not a hook, so it never changes the mood.
  applyStatus(st) {
    if (!st || typeof st !== 'object') return false;
    if (st.session_id) {
      const s = this.sessions.get(st.session_id) || this._session(st.session_id, st.workspace?.current_dir || st.cwd);
      if (st.context_window) {
        s.context = {
          pct: st.context_window.used_percentage ?? null,
          size: st.context_window.context_window_size ?? null,
        };
      }
      if (st.cost && typeof st.cost.total_cost_usd === 'number') s.cost = st.cost.total_cost_usd;
      if (st.model?.display_name) s.model = st.model.display_name;
      if (st.session_name) s.name = st.session_name;
    }
    if (st.rate_limits && typeof st.rate_limits === 'object') {
      const pick = (w) => (w && typeof w.used_percentage === 'number'
        ? { pct: w.used_percentage, resetsAt: w.resets_at ? w.resets_at * 1000 : null }
        : null);
      this.limits = {
        fiveHour: pick(st.rate_limits.five_hour),
        sevenDay: pick(st.rate_limits.seven_day),
        spend: st.rate_limits.spend_limit ? {
          ...pick(st.rate_limits.spend_limit),
          usedUsd: st.rate_limits.spend_limit.used_usd ?? null,
          limitUsd: st.rate_limits.spend_limit.limit_usd ?? null,
          period: st.rate_limits.spend_limit.period ?? null,
        } : null,
        updatedAt: Date.now(),
      };
    }
    return true;
  }

  // Time-based transitions. Returns true if anything changed.
  tick(now = Date.now()) {
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (now - s.updatedAt > FORGET_MS) {
        this.sessions.delete(id);
        changed = true;
        continue;
      }
      if (s.moodUntil && now >= s.moodUntil) {
        this._setMood(s, s.afterMood || 'idle', { activity: s.afterMood === 'thinking' ? s.activity : null });
        changed = true;
      }
      const busy = s.mood === 'working' || s.mood === 'thinking' || s.mood === 'compacting';
      if (busy && now - s.updatedAt > STALE_BUSY_MS) {
        this._setMood(s, 'idle', { activity: null });
        changed = true;
      }
      if (s.mood === 'idle' && now - s.updatedAt > SLEEP_MS) {
        this._setMood(s, 'sleeping', { activity: null });
        changed = true;
      }
    }
    // Drop rate-limit windows that have reset; the next status line update brings fresh numbers.
    if (this.limits) {
      for (const k of ['fiveHour', 'sevenDay', 'spend']) {
        const w = this.limits[k];
        if (w && w.resetsAt && now >= w.resetsAt) {
          this.limits[k] = { pct: 0, resetsAt: null, stale: true };
          changed = true;
        }
      }
    }
    return changed;
  }

  overallMood() {
    if (this.sessions.size === 0) {
      return this.lastEventAt && Date.now() - this.lastEventAt < SLEEP_MS ? 'idle' : 'sleeping';
    }
    let best = 'sleeping';
    for (const s of this.sessions.values()) {
      if (MOOD_PRIORITY.indexOf(s.mood) < MOOD_PRIORITY.indexOf(best)) best = s.mood;
    }
    return best;
  }

  snapshot() {
    const sessions = [...this.sessions.values()]
      .sort((a, b) => MOOD_PRIORITY.indexOf(a.mood) - MOOD_PRIORITY.indexOf(b.mood) || b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        project: s.project,
        name: s.name || null,
        mood: s.mood,
        activity: s.activity,
        message: s.message,
        subagents: s.subagents,
        context: s.context,
        cost: s.cost,
        model: s.model,
        updatedAt: s.updatedAt,
      }));
    return {
      mood: this.overallMood(),
      focus: sessions[0] || null,
      sessions,
      limits: this.limits,
      event: this.event,
      serverTime: Date.now(),
    };
  }
}
