import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, testOutputFailed } from '../src/events.js';
import { BuddyState } from '../src/state.js';

const kind = (c) => classifyCommand(c).kind;
const scary = (c) => classifyCommand(c).scary;

test('spots test runs', () => {
  for (const c of [
    'npm test', 'npm run test', 'npm t', 'npm run test:unit -- --watch=false', 'yarn test', 'pnpm test', 'pnpm -r test',
    'npm --prefix web test', 'npm run -s test', 'npx jest src', 'npx --yes vitest run', 'pnpm vitest run', 'pnpm exec vitest',
    'vitest run', 'pytest -q', 'python -m pytest tests/', 'python3.12 -m pytest', 'uv run pytest', 'poetry run pytest',
    '.venv/bin/pytest', './node_modules/.bin/jest', 'python manage.py test', 'go test ./...', 'cargo test', 'swift test --parallel',
    'xcodebuild -scheme App -destination "platform=iOS Simulator,name=iPhone 16" test', 'cd app && CI=1 npm test',
    'timeout 60 npm test', 'env FOO=1 npm test', '(cd web && npm test)', 'node --test test/*.test.js', './gradlew test',
    'make test', 'bundle exec rspec', 'npm test 2>&1 | tail -20',
  ]) assert.equal(kind(c), 'test', c);
});

test('spots commits and pushes', () => {
  assert.equal(kind('git commit -m "x"'), 'commit');
  assert.equal(kind('git -C repo commit -am x'), 'commit');
  assert.equal(kind('git -c user.name="A B" commit -m x'), 'commit');
  assert.equal(kind('git add . && git commit -m x && git push -u origin main'), 'push');
  assert.equal(kind('git push --force-with-lease'), 'push');
  assert.equal(kind('git push --dry-run'), null);
  assert.equal(kind('git commit-tree abc'), null);
  assert.equal(kind('make test-data'), null);
});

test('commit messages and heredocs are data, not commands', () => {
  const heredoc = `git commit -m "$(cat <<'EOF'\nRemove the rm -rf / footgun\n\nnpm test now passes; git push --force is gone\nEOF\n)"`;
  assert.deepEqual(classifyCommand(heredoc), { scary: false, kind: 'commit' });
  assert.deepEqual(classifyCommand('git commit -m "a; rm -rf /"'), { scary: false, kind: 'commit' });
  assert.deepEqual(classifyCommand("cat > t.sh <<'EOF'\nnpm test\nrm -rf /\nEOF"), { scary: false, kind: null });
  assert.equal(scary('grep -n "DROP TABLE" migrations/*.sql'), false);
  assert.equal(scary('echo hi # rm -rf /'), false);
});

test('spots scary commands, but not routine cleanup', () => {
  for (const c of ['rm -rf /', 'sudo rm -Rf /', 'rm -rf ~', 'rm -rf ~/code', 'rm -fr $HOME', 'rm -rf .', 'rm -rf ..', 'rm -rf *',
    'rm -rf .git', 'rm -r -f ../other', 'rm --recursive --force /Users/me', 'git push --force', 'git push -f origin main',
    'git push origin +main', 'git reset --hard HEAD~3', 'git clean -fdx', 'psql -c "DROP TABLE users"']) assert.equal(scary(c), true, c);
  for (const c of ['rm -rf node_modules', 'rm -rf build dist', 'rm -rf /tmp/scratch', 'rm -rf /Users/me/code/app/build',
    'rm file.txt', 'rm -r dir', 'git clean -nfd', 'git status', 'ls -la']) assert.equal(scary(c), false, c);
  // Cleanup before a test still counts as a test run.
  assert.deepEqual(classifyCommand('rm -rf dist && npm test'), { scary: false, kind: 'test' });
  assert.deepEqual(classifyCommand('rm -rf . && npm test'), { scary: true, kind: 'test' });
});

test('ignores the rest', () => {
  for (const c of ['ls -la', 'git status', 'git log --grep=commit', 'echo npm test is cool', 'cat test.js', 'npm install', '', null]) {
    assert.deepEqual(classifyCommand(c), { scary: false, kind: null }, String(c));
  }
});

test('testOutputFailed reads the result', () => {
  for (const out of ['Tests: 12 passed, 12 total', '# pass 14\n# fail 0', '3 passed, 0 failed', 'ok 3 - handles 2 errors gracefully',
    '✓ reports 1 failure', 'Tests run: 5, Failures: 0']) assert.equal(testOutputFailed({ stdout: out }), false, out);
  for (const out of ['Tests: 2 failed, 10 passed', '# fail 2', 'ℹ fail 1', '** TEST FAILED **', 'FAIL src/a.test.js', ' FAIL  src/x',
    '--- FAIL: TestX (0.00s)', 'FAILED tests/x.py::t - assert 1 == 2', 'Tests run: 5, Failures: 1', 'test result: FAILED. 1 passed; 1 failed']) {
    assert.equal(testOutputFailed({ stdout: out }), true, out);
  }
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
  bash('PreToolUse', 'rm -rf ~/code');
  const e = st.snapshot().event;
  assert.equal(e.kind, 'scary');
  assert.equal(e.project, 'app');
  assert.equal(e.detail, undefined); // commands never leave the computer
  bash('PostToolUse', 'git commit -m x');
  assert.equal(st.snapshot().event.kind, 'commit');
  assert.ok(st.snapshot().event.seq > e.seq);
  bash('PostToolUseFailure', 'npm test', { is_interrupt: true });
  assert.equal(st.snapshot().event.kind, 'commit'); // an interrupt is not a failure
  st.applyHook({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true }, tool_response: {} });
  assert.equal(st.snapshot().event.kind, 'commit'); // a background run has not finished yet
});
