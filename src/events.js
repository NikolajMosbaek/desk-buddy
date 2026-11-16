// Spot the shell commands worth a reaction: tests, commits, pushes and the scary ones.
// Pure functions on the command string, so they are easy to test.

// Remove what is data rather than commands: heredoc bodies, quoted strings and comments.
// Commit messages are full of words like "test" and "rm -rf"; they must not count.
function stripData(cmd) {
  return String(cmd || '')
    .replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$|\))/g, '<<H')
    .replace(/"(?:[^"\\]|\\[\s\S])*"/g, 'Q')
    .replace(/'[^']*'/g, 'Q')
    .replace(/(^|\s)#[^\n]*/g, '$1');
}

// Wrappers that don't change what runs: `timeout 60 npm test`, `uv run pytest` …
const WRAPPER = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+|(?:time|nice|command|exec|xcrun|sudo|env)\s+|timeout\s+\S+\s+|(?:uv|poetry|pipenv|pdm|hatch)\s+run\s+|(?:pnpm|bun|yarn)\s+exec\s+|bundle\s+exec\s+|npx\s+(?:--?\S+\s+)*)/;

// Split into simple commands (on && || ; | & and newlines), unwrap, and drop path prefixes.
function segments(stripped) {
  return stripped
    .split(/&&|\|\||[;|&\n]/)
    .map((s) => {
      s = s.trim().replace(/^[({]\s*/, '').replace(/\s*[)}]$/, '');
      for (let prev = null; prev !== s;) { prev = s; s = s.replace(WRAPPER, ''); }
      return s.replace(/^(?:\S*\/)(?=[\w.-]+(?:\s|$))/, ''); // ./node_modules/.bin/jest → jest
    })
    .filter(Boolean);
}

const END = '(?=\\s|$)';
const TEST_RES = [
  // npm test, npm run test:unit, npm --prefix web test, pnpm -r test, npm run -s test
  new RegExp(`^(?:npm|pnpm|bun|yarn)(?:\\s+-[-\\w]+(?:[ =](?!(?:test|t|run)${END})[^-\\s]\\S*)?)*\\s+(?:run(?:\\s+-\\S+)*\\s+)?(?:test|t)(?::\\S+)?${END}`),
  new RegExp(`^(?:pnpm|yarn|bun)\\s+(?:jest|vitest|mocha|ava|playwright\\s+test)${END}`),
  new RegExp(`^(?:jest|vitest|mocha|ava|pytest|py\\.test|rspec|phpunit|tox|nox)${END}`),
  new RegExp(`^playwright\\s+test${END}`),
  new RegExp(`^python[\\d.]*\\s+(?:-m\\s+(?:pytest|unittest)|manage\\.py\\s+test)${END}`),
  new RegExp(`^(?:go|cargo|swift|deno|bun|dotnet|mix|flutter|dart)\\s+test${END}`),
  /^node\s+(?:\S+\s+)*--test(?:\s|$|=)/,
  new RegExp(`^(?:gradlew|gradle|mvn|mvnw|make)\\s+(?:\\S+\\s+)*(?:test|check|verify)${END}`),
  new RegExp(`^xcodebuild\\s+.*\\stest(?:-without-building)?${END}`),
  new RegExp(`^fastlane\\s+(?:\\S+\\s+)*(?:test|tests|scan)${END}`),
];

// git with optional global options before the subcommand (`git -C dir commit`).
const git = (sub) => new RegExp(`^git(?:\\s+(?:-C\\s+\\S+|-c\\s+\\S+|--[\\w-]+(?:=\\S+)?))*\\s+${sub}${END}`);
const GIT_COMMIT = git('commit');
const GIT_PUSH = git('push');
const DRY_RUN = /\s(?:--dry-run|-n)(?=\s|$)/;

// rm -rf is routine (node_modules, build). It is only scary near the top of the disk,
// at home, at the current directory or above it, or on .git.
function isScaryRm(seg) {
  const m = /^rm\s+(.*)$/.exec(seg);
  if (!m) return false;
  let r = false, f = false;
  const targets = [];
  for (const a of m[1].split(/\s+/)) {
    if (a === '--recursive') r = true;
    else if (a === '--force') f = true;
    else if (/^-[a-zA-Z]+$/.test(a)) { if (/[rR]/.test(a)) r = true; if (/f/.test(a)) f = true; }
    else if (a && a !== '--') targets.push(a);
  }
  if (!r || !f) return false;
  return targets.some((t) => {
    const p = t.replace(/\/+$/, '') || '/';
    if (['/', '/*', '~', '~/*', '$HOME', '${HOME}', '.', './*', '..', '*'].includes(p)) return true;
    if (/(^|\/)\.git$/.test(p) || /(^|\/)\.\.(\/|$)/.test(p)) return true;
    // Shallow absolute or home paths: /Users/me, /usr/local, ~/code
    if (/^(?:\/|~\/|\$HOME\/|\$\{HOME\}\/)/.test(p)) {
      if (/^\/(?:tmp|private\/tmp|var\/folders)\//.test(p)) return false;
      const depth = p.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, '/HOME').split('/').filter(Boolean).length;
      return depth <= 2;
    }
    return false;
  });
}

const SCARY_RES = [
  new RegExp(git('push').source + '.*(?:\\s--force(?=\\s|$)|\\s-f(?=\\s|$)|\\s\\+\\S)'),
  new RegExp(git('reset').source + '.*\\s--hard(?=\\s|$)'),
  /^(?:mkfs\S*|dd\s+.*\bof=\/dev\/)/,
  /^chmod\s+-R\s+777\s/,
];
const GIT_CLEAN = new RegExp(git('clean').source + '((?:\\s+-\\S+)*)');
const DB_CLIENT = /^(?:psql|mysql|mariadb|sqlite3|sqlcmd|duckdb|clickhouse-client|mongosh)(?=\s|$)/;
const DESTRUCTIVE_SQL = /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i;

function isScarySegment(s) {
  if (isScaryRm(s) || SCARY_RES.some((re) => re.test(s))) return true;
  const clean = GIT_CLEAN.exec(s);
  if (!clean) return false;
  const flags = clean[1].split(/\s+/).filter((a) => /^-[a-zA-Z]+$/.test(a)).join('');
  return /f/.test(flags) && !/n/.test(flags) && !/--dry-run/.test(clean[1]);
}

// What is in this command? `scary` is for the moment before it runs; `kind` (push, commit
// or test, most interesting first) is for when it has finished.
export function classifyCommand(cmd) {
  const segs = segments(stripData(cmd));
  // SQL sits inside quotes, so look at the raw command, but only when a DB client runs.
  const scary = segs.some(isScarySegment) || (segs.some((s) => DB_CLIENT.test(s)) && DESTRUCTIVE_SQL.test(String(cmd)));
  let kind = null;
  if (segs.some((s) => GIT_PUSH.test(s) && !DRY_RUN.test(s))) kind = 'push';
  else if (segs.some((s) => GIT_COMMIT.test(s) && !DRY_RUN.test(s))) kind = 'commit';
  else if (segs.some((s) => TEST_RES.some((re) => re.test(s)))) kind = 'test';
  return { scary, kind };
}

// A test run can "succeed" as a tool call (piped through tail, `|| true`) and still report
// failures in its output. Lines that are themselves passing tests are ignored.
const PASS_LINE = /^\s*(?:ok\b|✓|✔|√|PASS\b)/;
const FAIL_LINE = [
  /^\s*(?:---\s+)?FAIL(?:ED)?\b/, // jest, vitest, go, pytest short summary
  /^\s*[#ℹ]\s*fail\s+[1-9]/, // node --test
  /\b[1-9]\d*\s+(?:failed|failing|failures)\b/i, // "2 failed", "3 failing"
  /\b(?:failures|failed):\s*[1-9]/i, // JUnit/Maven "Failures: 1"
  /\*\* TEST FAILED \*\*/, // xcodebuild
  /\bTest Suite .* failed\b/, // XCTest
  /\btest result: FAILED\b/, // cargo
];

export function testOutputFailed(response) {
  if (!response || typeof response !== 'object') return false;
  if (typeof response.exitCode === 'number' && response.exitCode !== 0) return true;
  const out = `${response.stdout || ''}\n${response.stderr || ''}`;
  return out.split('\n').some((line) => !PASS_LINE.test(line) && FAIL_LINE.some((re) => re.test(line)));
}
