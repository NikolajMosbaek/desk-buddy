// Demo mode: plays a scripted Claude Code session in a loop, so you can try the
// buddy on a phone without Claude Code. Events go through the same BuddyState
// code path as real hooks, so what you see is exactly what real use looks like.

const APP = '/Users/demo/code/weather-app';
const API = '/Users/demo/code/weather-api';

const a = (e) => ({ session_id: 'demo-a', cwd: APP, ...e });
const b = (e) => ({ session_id: 'demo-b', cwd: API, ...e });
const tool = (s, name, input) => s({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input });
const post = (s) => s({ hook_event_name: 'PostToolUse' });

// [seconds to wait before the step, hook events to apply, optional usage step]
const SCRIPT = [
  [2, [a({ hook_event_name: 'SessionStart' })]],
  [4, [a({ hook_event_name: 'UserPromptSubmit' })], { tokens: 40_000, five: 1 }],
  [3, [tool(a, 'Read', { file_path: `${APP}/Sources/ForecastView.swift` })]],
  [2.5, [post(a), tool(a, 'Grep', { pattern: 'TemperatureFormatter' })]],
  [2.5, [post(a), tool(a, 'Edit', { file_path: `${APP}/Sources/ForecastView.swift` })], { tokens: 90_000, ctx: 4 }],
  [3, [post(a), tool(a, 'Write', { file_path: `${APP}/Tests/ForecastViewTests.swift` })]],
  [3, [post(a), tool(a, 'Bash', { command: 'swift test', description: 'Run unit tests' })], { tokens: 60_000, five: 1 }],
  [4, [post(a), a({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push origin main', description: 'Push to GitHub' } })]],
  [6, [post(a)]],
  [2, [a({ hook_event_name: 'Stop' })], { tokens: 30_000, ctx: 3 }],
  [7, [b({ hook_event_name: 'SessionStart' }), b({ hook_event_name: 'UserPromptSubmit' })]],
  [3, [tool(b, 'Agent', { description: 'Explore the API routes', subagent_type: 'Explore' }), b({ hook_event_name: 'SubagentStart', agent_type: 'Explore' })], { tokens: 120_000, five: 2 }],
  [4, [tool(b, 'WebFetch', { url: 'https://api.open-meteo.com/v1/forecast' })]],
  [3, [post(b), b({ hook_event_name: 'SubagentStop' }), tool(b, 'Edit', { file_path: `${API}/src/routes/forecast.ts` })], { tokens: 80_000, ctx: 6 }],
  [3, [post(b), b({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', error: 'npm test: 1 failing (forecast returns °F)' })]],
  [3.5, [tool(b, 'Edit', { file_path: `${API}/src/units.ts` })]],
  [3, [post(b), b({ hook_event_name: 'Stop' })], { tokens: 50_000, five: 1 }],
  [7, [b({ hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API Error: Overloaded' })]],
  [5, [b({ hook_event_name: 'SessionEnd' }), a({ hook_event_name: 'SessionEnd' })]],
  [8, []], // a short rest before the loop starts over
];

export function startDemo({ state, onChange }) {
  const START = {
    day: Date.now(), input: 180_000, output: 320_000, cacheWrite: 1_400_000, cacheRead: 11_600_000,
    messages: 410, byModel: {},
  };
  const usage = { ...START };
  let five = 24;
  let ctx = 9;
  const resetsFive = Date.now() + (2 * 3600 + 41 * 60) * 1000;
  const resetsWeek = Date.now() + (3 * 86400 + 7 * 3600) * 1000;

  const status = (sid) => state.applyStatus({
    session_id: sid,
    model: { display_name: 'Opus 5.5' },
    context_window: { used_percentage: ctx, context_window_size: 1_000_000 },
    rate_limits: {
      five_hour: { used_percentage: five, resets_at: Math.floor(resetsFive / 1000) },
      seven_day: { used_percentage: 47, resets_at: Math.floor(resetsWeek / 1000) },
    },
  });

  let i = 0;
  let timer = null;
  const step = () => {
    const [, events, u] = SCRIPT[i];
    let sid = null;
    for (const ev of events) {
      state.applyHook(ev);
      if (ev.hook_event_name !== 'SessionEnd') sid = ev.session_id;
    }
    if (u) {
      usage.cacheRead += Math.round((u.tokens || 0) * 0.85);
      usage.cacheWrite += Math.round((u.tokens || 0) * 0.1);
      usage.output += Math.round((u.tokens || 0) * 0.04);
      usage.input += Math.round((u.tokens || 0) * 0.01);
      usage.messages += 3;
      five = Math.min(99, five + (u.five || 0));
      ctx = Math.min(95, ctx + (u.ctx || 0));
    }
    if (sid && state.sessions.has(sid)) status(sid);
    if (i === SCRIPT.length - 1) { five = 24; ctx = 9; Object.assign(usage, START); } // keep the loop believable
    onChange();
    i = (i + 1) % SCRIPT.length;
    timer = setTimeout(step, SCRIPT[i][0] * 1000);
  };
  timer = setTimeout(step, SCRIPT[0][0] * 1000);

  return {
    usage: () => ({ ...usage, total: usage.input + usage.output + usage.cacheWrite + usage.cacheRead }),
    stop: () => clearTimeout(timer),
  };
}
