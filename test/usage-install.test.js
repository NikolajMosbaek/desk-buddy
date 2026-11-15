import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, '.claude');
process.env.DESK_BUDDY_HOME = path.join(tmp, '.desk-buddy');
const { UsageTracker } = await import('../src/usage.js');
const { install, uninstall, installStatus, HOOK_EVENTS } = await import('../src/install.js');

test('usage counts today only and dedupes streamed lines', () => {
  const dir = path.join(tmp, '.claude', 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const line = (id, ts, n) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: 'r' + id, message: { id, usage: { input_tokens: n, output_tokens: 1 } } });
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, [line('m1', now, 10), line('m1', now, 10), line('m0', '2020-01-01T00:00:00Z', 999)].join('\n') + '\n');
  const u = new UsageTracker(path.join(tmp, '.claude', 'projects'));
  u.refresh();
  assert.equal(u.snapshot().total, 11);
  fs.appendFileSync(f, line('m2', now, 5) + '\n');
  u.refresh();
  assert.equal(u.snapshot().total, 17);
});

test('install is idempotent, keeps user hooks and status line, uninstall restores', () => {
  const settingsFile = path.join(tmp, '.claude', 'settings.json');
  const original = { statusLine: { type: 'command', command: 'echo mine' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say hi' }] }] } };
  fs.writeFileSync(settingsFile, JSON.stringify(original));
  const quiet = { log: () => {} };
  install(quiet);
  install(quiet);
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(s.hooks.Stop.length, 2);
  assert.equal(installStatus().hooks, HOOK_EVENTS.length);
  assert.match(s.statusLine.command, /statusline\.mjs/);
  uninstall(quiet);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), original);
});
