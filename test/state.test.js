import test from 'node:test';
import assert from 'node:assert/strict';
import { BuddyState, describeTool } from '../src/state.js';

const ev = (name, extra = {}) => ({ session_id: 's1', cwd: '/code/app', hook_event_name: name, ...extra });

test('prompt -> tool -> permission -> stop', () => {
  const st = new BuddyState();
  st.applyHook(ev('UserPromptSubmit'));
  assert.equal(st.overallMood(), 'thinking');
  st.applyHook(ev('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/code/app/A.swift' } }));
  assert.equal(st.overallMood(), 'working');
  assert.deepEqual(st.snapshot().focus.activity, { verb: 'edit', detail: 'A.swift' });
  st.applyHook(ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' } }));
  assert.equal(st.overallMood(), 'waiting');
  st.applyHook(ev('PostToolUse'));
  assert.equal(st.overallMood(), 'thinking');
  st.applyHook(ev('Stop'));
  assert.equal(st.overallMood(), 'done');
  st.tick(Date.now() + 7000);
  assert.equal(st.overallMood(), 'idle');
});

test('waiting in one session wins over working in another', () => {
  const st = new BuddyState();
  st.applyHook(ev('PreToolUse', { tool_name: 'Read', tool_input: {} }));
  st.applyHook({ ...ev('Notification', { notification_type: 'permission_prompt' }), session_id: 's2' });
  assert.equal(st.overallMood(), 'waiting');
  assert.equal(st.snapshot().focus.id, 's2');
});

test('stale busy session falls back to idle, then sleeps', () => {
  const st = new BuddyState();
  st.applyHook(ev('UserPromptSubmit'));
  st.tick(Date.now() + 11 * 60_000);
  assert.equal(st.overallMood(), 'idle');
  st.tick(Date.now() + 16 * 60_000);
  assert.equal(st.overallMood(), 'sleeping');
});

test('SessionEnd removes the session', () => {
  const st = new BuddyState();
  st.applyHook(ev('SessionStart'));
  st.applyHook(ev('SessionEnd'));
  assert.equal(st.sessions.size, 0);
});

test('status line rate limits are picked up', () => {
  const st = new BuddyState();
  st.applyStatus({ session_id: 's1', rate_limits: { five_hour: { used_percentage: 42, resets_at: 2_000_000_000 } } });
  assert.equal(st.snapshot().limits.fiveHour.pct, 42);
  assert.equal(st.snapshot().limits.sevenDay, null);
});

test('tool labels', () => {
  assert.deepEqual(describeTool('Bash', { command: 'ls', description: 'List files' }), { verb: 'say', detail: 'List files' });
  assert.deepEqual(describeTool('mcp__github__create_pull_request', {}), { verb: 'tool', detail: 'github · create_pull_request' });
});

test('demo mode drives the state through its moods', async () => {
  const { startDemo } = await import('../src/demo.js');
  const st = new BuddyState();
  const seen = new Set();
  const realSetTimeout = global.setTimeout;
  const queue = [];
  global.setTimeout = (fn) => { queue.push(fn); return queue.length; };
  try {
    const demo = startDemo({ state: st, onChange: () => seen.add(st.overallMood()) });
    for (let i = 0; i < 40 && queue.length; i++) queue.shift()();
    demo.stop();
    assert.ok(demo.usage().total > 0);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  for (const m of ['idle', 'thinking', 'working', 'waiting', 'done', 'error']) assert.ok(seen.has(m), `missing ${m}`);
});
