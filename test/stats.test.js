import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Stats, dayKey } from '../src/stats.js';

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('counts a day of work', () => {
  let t = at(2026, 11, 15, 9);
  const st = new Stats(null, { now: () => t });
  const h = (e, kind) => st.record({ session_id: 's1', ...e }, kind);
  h({ hook_event_name: 'UserPromptSubmit' });
  t += 60_000; h({ hook_event_name: 'PreToolUse', tool_name: 'Edit' });
  t += 60_000; h({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/a/x.swift' } });
  t += 60_000; h({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/a/x.swift' } });
  t += 60_000; h({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 'testsPass');
  t += 60_000; h({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, 'commit');
  t += 3 * 3600_000; st.record({ session_id: 's2', hook_event_name: 'UserPromptSubmit' }); // after a long break
  const d = st.today();
  assert.equal(d.date, '2026-11-15');
  assert.equal(d.prompts, 2);
  assert.equal(d.tools, 1);
  assert.equal(d.files, 1); // same file twice counts once
  assert.equal(d.sessions, 2);
  assert.equal(d.testsPass, 1);
  assert.equal(d.commits, 1);
  assert.equal(d.activeMs, 5 * 60_000); // the 3 h gap is not work
  assert.equal(st.lifetime().prompts, 2);
});

test('a new day starts from zero and the streak counts back', () => {
  let t = at(2026, 11, 12);
  const st = new Stats(null, { now: () => t });
  for (const day of [12, 13, 14]) { t = at(2026, 11, day); st.record({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }); }
  assert.equal(st.streak(), 3);
  t = at(2026, 11, 15, 8); // next morning, nothing yet: yesterday still counts
  assert.equal(st.today().prompts, 0);
  assert.equal(st.streak(), 3);
  st.record({ session_id: 'a', hook_event_name: 'UserPromptSubmit' });
  assert.equal(st.streak(), 4);
  assert.equal(st.today().sessions, 1); // the same session id counts again on a new day
  t = at(2026, 11, 17); // skipped the 16th
  assert.equal(st.streak(), 0);
});

test('persists privately, and never loses a file it cannot read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-stats-'));
  const file = path.join(dir, 'stats.json');
  const t = at(2026, 11, 15);
  const a = new Stats(file, { now: () => t });
  a.record({ session_id: 's', hook_event_name: 'UserPromptSubmit' });
  a.flush();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = new Stats(file, { now: () => t });
  assert.equal(b.today().prompts, 1);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('/'), 'no paths stored');

  // Broken JSON: moved aside, not overwritten.
  fs.writeFileSync(file, '{oops');
  const logs = [];
  const c = new Stats(file, { now: () => t, log: (m) => logs.push(m) });
  assert.equal(c.today().prompts, 0);
  assert.equal(logs.length, 1);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.bad-')).length, 1);

  // A newer version: read nothing, write nothing.
  fs.writeFileSync(file, JSON.stringify({ version: 2, days: {}, lifetime: {} }));
  const d = new Stats(file, { now: () => t });
  d.record({ session_id: 's', hook_event_name: 'UserPromptSubmit' });
  d.flush();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);

  // Parseable but malformed: sanitised, and recording still works.
  fs.writeFileSync(file, JSON.stringify({ version: 1, days: { '2026-11-15': { prompts: '3' }, junk: 1 }, lifetime: { prompts: -4 }, seen: { files: null } }));
  const e = new Stats(file, { now: () => t });
  e.record({ session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/a' } });
  e.record({ session_id: 's', hook_event_name: 'UserPromptSubmit' });
  assert.equal(e.today().prompts, 1);
  assert.equal(e.today().files, 1);
  assert.equal(e.lifetime().prompts, 1);
  fs.rmSync(dir, { recursive: true });
});

test('active time ignores waiting and idle notifications', () => {
  let t = at(2026, 11, 15, 9);
  const st = new Stats(null, { now: () => t });
  const h = (name, gapMin) => { t += gapMin * 60_000; st.record({ session_id: 's', hook_event_name: name }); };
  h('UserPromptSubmit', 0);
  h('PreToolUse', 1); // +1
  h('PermissionRequest', 1); // waiting starts: +0
  h('PostToolUse', 4); // the wait itself: +0
  h('PreToolUse', 1); // +1
  h('PostToolUse', 20); // a 20 min build: +20
  h('Notification', 2); // +0
  assert.equal(st.today().activeMs, 22 * 60_000);
});

test('streak is right across a DST change', () => {
  // Europe: clocks go forward on 29 March 2026.
  let t = at(2026, 3, 27);
  const st = new Stats(null, { now: () => t });
  for (const d of [27, 28, 29]) { t = at(2026, 3, d); st.record({ session_id: 'a', hook_event_name: 'UserPromptSubmit' }); }
  for (const h of [0, 1, 2]) { t = at(2026, 3, 30, h, 30); assert.equal(st.streak(), 3); }
});

test('dayKey uses local time', () => {
  assert.equal(dayKey(at(2026, 1, 2, 0, 5)), '2026-01-02');
});
