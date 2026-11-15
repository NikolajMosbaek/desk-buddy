import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { Approvals, sign, newApprovalKey, normaliseKey } from '../src/approvals.js';

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
  assert.equal(globalThis.BuddyHMAC.hmacHex(normaliseKey(KEY), 'id1:allow'), sign(KEY, 'id1', 'allow'));
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
  assert.equal(ap.answer({ id, decision: 'allow', mac: sign('WRONG-KEY-WRONG-KEY', id, 'allow') }).status, 403);
  assert.equal(ap.answer({ id, decision: 'allow', mac: sign(KEY, id, 'deny') }).status, 403, 'a deny signature cannot allow');
  assert.equal(res.body, null);
  assert.equal(ap.answer({ id, decision: 'allow', mac: sign(KEY, id, 'allow') }).ok, true);
  assert.deepEqual(JSON.parse(res.body), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(ap.snapshot(), null);
  assert.equal(ap.answer({ id, decision: 'allow', mac: sign(KEY, id, 'allow') }).status, 410, 'no replay');
  ap.close();
});

test('deny, terminal answers, timeouts and lockout', () => {
  let t = 0;
  const ap = new Approvals({ settings: () => ({ enabled: true, key: KEY, waitSec: 60 }), now: () => t });
  const ev = { hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } };
  const r1 = fakeRes();
  const id1 = ap.hold(ev, r1);
  ap.answer({ id: id1, decision: 'deny', mac: sign(KEY, id1, 'deny') });
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
  const quick = await fetch(`${base}/hook`, { method: 'POST', body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } }) });
  assert.equal(await quick.text(), '{}');

  // A phone connects.
  const sse = http.get(`${base}/events?t=tok12345`);
  await new Promise((r) => sse.once('response', r));
  const hook = fetch(`${base}/hook`, { method: 'POST', body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', cwd: '/x/app', tool_name: 'Bash', tool_input: { command: 'git push' } }) });
  let q = null;
  for (let i = 0; i < 50 && !q; i++) {
    await new Promise((r) => setTimeout(r, 20));
    q = (await (await fetch(`${base}/api/state?t=tok12345`)).json()).approval;
  }
  assert.ok(q, 'the phone sees the question');
  const noToken = await fetch(`${base}/api/approve`, { method: 'POST', body: JSON.stringify({ id: q.id, decision: 'allow', mac: sign(KEY, q.id, 'allow') }) });
  assert.equal(noToken.status, 401);
  const ok = await fetch(`${base}/api/approve?t=tok12345`, { method: 'POST', body: JSON.stringify({ id: q.id, decision: 'allow', mac: sign(KEY, q.id, 'allow') }) });
  assert.equal(ok.status, 200);
  const out = JSON.parse(await (await hook).text());
  assert.equal(out.hookSpecificOutput.decision.behavior, 'allow');
  const after = await (await fetch(`${base}/api/state?t=tok12345`)).json();
  assert.equal(after.approval, null);
  assert.equal(after.mood, 'thinking');

  sse.destroy();
  server.closeAllConnections?.();
  server.close();
  delete process.env.DESK_BUDDY_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(home, { recursive: true });
});
