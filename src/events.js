// Spot the shell commands worth a reaction: tests, commits, pushes and the scary ones.
// Pure functions on the command string, so they are easy to test.

// Split a shell line into simple commands (on && || ; | and newlines) and drop leading
// `VAR=value` assignments and wrappers that don't change what runs.
function segments(cmd) {
  return String(cmd || '')
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim()
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
      .replace(/^(?:time|nice|command|exec|xcrun)\s+/, ''))
    .filter(Boolean);
}

const TEST_RES = [
  /^(?:npm|pnpm|bun)\s+(?:run\s+)?(?:test|t)(?::\S+)?(?:\s|$)/,
  /^yarn\s+(?:run\s+)?test(?::\S+)?(?:\s|$)/,
  /^(?:npx|pnpx|bunx|yarn)\s+(?:jest|vitest|mocha|ava|playwright\s+test)\b/,
  /^(?:jest|vitest|mocha|ava|pytest|rspec|phpunit|tox|nox)(?:\s|$)/,
  /^bundle\s+exec\s+rspec\b/,
  /^python3?\s+-m\s+(?:pytest|unittest)\b/,
  /^(?:go|cargo|swift|deno|bun|dotnet|mix|flutter|dart)\s+test\b/,
  /^node\s+(?:\S+\s+)*--test\b/,
  /^(?:\.\/)?(?:gradlew|gradle|mvn|mvnw|make)\s+(?:\S+\s+)*(?:test|check|verify)\b/,
  /^xcodebuild\s+.*\btest(?:-without-building)?\b/,
  /^fastlane\s+(?:\S+\s+)*(?:test|scan)\b/,
];

// git with optional global options before the subcommand (`git -C dir commit`).
const git = (sub) => new RegExp(`^git(?:\\s+(?:-C\\s+\\S+|-c\\s+\\S+|--[\\w-]+(?:=\\S+)?))*\\s+${sub}\\b`);
const GIT_COMMIT = git('commit');
const GIT_PUSH = git('push');

function isRmRf(seg) {
  const m = /^(?:sudo\s+)?rm\s+(.*)$/.exec(seg);
  if (!m) return false;
  let r = false, f = false;
  for (const a of m[1].split(/\s+/)) {
    if (a === '--recursive') r = true;
    else if (a === '--force') f = true;
    else if (/^-[a-zA-Z]+$/.test(a)) { if (/[rR]/.test(a)) r = true; if (/f/.test(a)) f = true; }
  }
  return r && f;
}

const SCARY_RES = [
  new RegExp(git('push').source + '.*(?:\\s--force(?!-with-lease)(?:\\s|$)|\\s-f(?:\\s|$))'),
  new RegExp(git('reset').source + '.*\\s--hard\\b'),
  new RegExp(git('clean').source + '.*\\s-[a-zA-Z]*f'),
  /^(?:sudo\s+)?(?:mkfs\S*|dd\s+.*\bof=\/dev\/)/,
  /^(?:sudo\s+)?chmod\s+-R\s+777\b/,
  /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i,
];

// What kind of command is this? 'scary' wins over everything, then push, commit, test.
export function classifyCommand(cmd) {
  const segs = segments(cmd);
  if (!segs.length) return null;
  if (segs.some((s) => isRmRf(s) || SCARY_RES.some((re) => re.test(s)))) return 'scary';
  if (segs.some((s) => GIT_PUSH.test(s))) return 'push';
  if (segs.some((s) => GIT_COMMIT.test(s))) return 'commit';
  if (segs.some((s) => TEST_RES.some((re) => re.test(s)))) return 'test';
  return null;
}

// A test run can "succeed" as a tool call and still report failures in its output.
const FAIL_OUTPUT = /\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b|\btests? failed\b|\*\* TEST FAILED \*\*|\bFAILED \(|^FAIL\b|^# fail [1-9]/im;
const ZERO_FAIL = /\b0\s+(?:tests?\s+)?(?:failed|failing|failures?)\b/gi;

export function testOutputFailed(response) {
  if (!response || typeof response !== 'object') return false;
  if (typeof response.exitCode === 'number' && response.exitCode !== 0) return true;
  if (response.interrupted) return true;
  const out = `${response.stdout || ''}\n${response.stderr || ''}`;
  return FAIL_OUTPUT.test(out.replace(ZERO_FAIL, ''));
}
