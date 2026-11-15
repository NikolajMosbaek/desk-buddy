import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, testOutputFailed } from '../src/events.js';
import { BuddyState } from '../src/state.js';

test('classifyCommand spots tests', () => {
  for (const c of [
    'npm test', 'npm run test', 'npm t', 'npm run test:unit -- --watch=false', 'yarn test', 'pnpm test',
    'npx jest src', 'vitest run', 'pytest -q', 'python -m pytest tests/', 'go test ./...', 'cargo test',
    'swift test --parallel', 'xcodebuild -scheme App -destination "platform=iOS Simulator,name=iPhone 16" test',
    'cd app && CI=1 npm test', 'node --test test/*.test.js', './gradlew test', 'make test', 'bundle exec rspec',
  ]) assert.equal(classifyCommand(c), 'test', c);
});

test('classifyCommand spots git and scary commands', () => {
  assert.equal(classifyCommand('git commit -m "x"'), 'commit');
  assert.equal(classifyCommand('git -C repo commit -am x'), 'commit');
  assert.equal(classifyCommand('git add . && git commit -m x && git push -u origin main'), 'push');
  assert.equal(classifyCommand('git push --force-with-lease'), 'push');
  for (const c of ['rm -rf build', 'rm -fr /tmp/x', 'rm -r -f x', 'sudo rm -Rf /', 'rm --recursive --force x',
    'git push --force', 'git push -f origin main', 'git reset --hard HEAD~3', 'git clean -fdx',
    'psql -c "DROP TABLE users"', 'npm test && rm -rf dist']) assert.equal(classifyCommand(c), 'scary', c);
});

test('classifyCommand ignores the rest', () => {
  for (const c of ['ls -la', 'rm file.txt', 'rm -r dir', 'git status', 'git log --grep=commit', 'echo npm test is cool',
    'cat test.js', 'npm install', 'git commitizen', '', null]) assert.equal(classifyCommand(c), null, String(c));
});

test('testOutputFailed reads the result', () => {
  assert.equal(testOutputFailed({ stdout: 'Tests: 12 passed, 12 total' }), false);
  assert.equal(testOutputFailed({ stdout: '# pass 14\n# fail 0' }), false);
  assert.equal(testOutputFailed({ stdout: '3 passed, 0 failed' }), false);
  assert.equal(testOutputFailed({ stdout: 'Tests: 2 failed, 10 passed' }), true);
  assert.equal(testOutputFailed({ stdout: '# fail 2' }), true);
  assert.equal(testOutputFailed({ stdout: '** TEST FAILED **' }), true);
  assert.equal(testOutputFailed({ stdout: 'FAIL src/a.test.js' }), true);
  assert.equal(testOutputFailed({ stdout: 'ok', exitCode: 1 }), true);
  assert.equal(testOutputFailed(null), false);
});

test('BuddyState records an event per noteworthy command', () => {
  const st = new BuddyState();
  const bash = (name, command, extra = {}) => st.applyHook({ hook_event_name: name, session_id: 's', cwd: '/p/app', tool_name: 'Bash', tool_input: { command }, ...extra });
  bash('PreToolUse', 'npm test');
  assert.equal(st.snapshot().event, null);
  bash('PostToolUse', 'npm test', { tool_response: { stdout: '# pass 3\n# fail 0' } });
  assert.equal(st.snapshot().event.kind, 'testsPass');
  bash('PostToolUseFailure', 'npm test', { error: 'Exit code 1' });
  assert.equal(st.snapshot().event.kind, 'testsFail');
  assert.equal(st.snapshot().mood, 'error');
  bash('PreToolUse', 'rm -rf node_modules');
  const e = st.snapshot().event;
  assert.equal(e.kind, 'scary');
  assert.equal(e.project, 'app');
  bash('PostToolUse', 'git commit -m x');
  assert.equal(st.snapshot().event.kind, 'commit');
  assert.ok(st.snapshot().event.seq > e.seq);
  bash('PostToolUseFailure', 'npm test', { is_interrupt: true });
  assert.equal(st.snapshot().event.kind, 'commit'); // an interrupt is not a failure
});
