import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir, buddyDir, loadConfig, saveConfig } from './config.js';

export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Elicitation',
  'ElicitationResult',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Stop',
  'StopFailure',
];

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function settingsPath() {
  return path.join(claudeDir(), 'settings.json');
}

function readSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return {};
  const txt = fs.readFileSync(file, 'utf8');
  if (!txt.trim()) return {};
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new Error(`Could not parse ${file} (${e.message}). Fix it or move it aside, then run install again.`);
  }
}

function writeSettings(settings) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, `${file}.desk-buddy-backup-${stamp}`);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const isOurHook = (h) => h && h.type === 'http' && typeof h.url === 'string' && /\/\/(127\.0\.0\.1|localhost):\d+\/hook$/.test(h.url)
  && h.headers?.['X-Desk-Buddy'] === '1';

function stripOurHooks(hooks) {
  if (!hooks) return hooks;
  for (const ev of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const kept = [];
    for (const g of groups) {
      const inner = (g.hooks || []).filter((h) => !isOurHook(h));
      if (inner.length) kept.push({ ...g, hooks: inner });
    }
    if (kept.length) hooks[ev] = kept;
    else delete hooks[ev];
  }
  return hooks;
}

function bridgePath() {
  return path.join(buddyDir(), 'statusline.mjs');
}

function isOurStatusLine(sl) {
  return sl && typeof sl.command === 'string' && sl.command.includes('statusline.mjs') && sl.command.includes('desk-buddy');
}

export function install({ statusline = true, log = console.log } = {}) {
  const cfg = loadConfig();
  const settings = readSettings();

  settings.hooks = stripOurHooks(settings.hooks || {});
  const url = `http://127.0.0.1:${cfg.port}/hook`;
  for (const ev of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    list.push({ hooks: [{ type: 'http', url, timeout: 2, headers: { 'X-Desk-Buddy': '1' } }] });
    settings.hooks[ev] = list;
  }
  log(`Added ${HOOK_EVENTS.length} hooks pointing at ${url}`);

  if (statusline) {
    fs.mkdirSync(buddyDir(), { recursive: true });
    fs.copyFileSync(path.join(SRC_DIR, 'statusline-bridge.mjs'), bridgePath());
    const current = settings.statusLine;
    if (current && !isOurStatusLine(current)) {
      cfg.wrappedStatusLine = current; // keep theirs; the bridge runs it and prints its output
      log(`Your existing status line is kept: desk-buddy wraps it (${current.command}).`);
    } else if (!current) {
      delete cfg.wrappedStatusLine;
    }
    saveConfig(cfg);
    const prev = cfg.wrappedStatusLine || {};
    settings.statusLine = {
      ...prev,
      type: 'command',
      command: `node "${bridgePath()}"`,
    };
    log('Status line bridge installed (this is how real 5h/7d limit numbers reach the buddy).');
  }

  writeSettings(settings);
  log(`Updated ${settingsPath()} (a backup was saved next to it).`);
  return cfg;
}

export function uninstall({ log = console.log } = {}) {
  const cfg = loadConfig({ create: false });
  const settings = readSettings();
  settings.hooks = stripOurHooks(settings.hooks || {});
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (isOurStatusLine(settings.statusLine)) {
    if (cfg.wrappedStatusLine) settings.statusLine = cfg.wrappedStatusLine;
    else delete settings.statusLine;
    delete cfg.wrappedStatusLine;
    saveConfig(cfg);
  }
  writeSettings(settings);
  try { fs.unlinkSync(bridgePath()); } catch { /* already gone */ }
  log(`Removed desk-buddy hooks and status line from ${settingsPath()}.`);
}

export function installStatus() {
  const settings = readSettings();
  const hooked = HOOK_EVENTS.filter((ev) => (settings.hooks?.[ev] || []).some((g) => (g.hooks || []).some(isOurHook)));
  return {
    settingsFile: settingsPath(),
    hooks: hooked.length,
    hooksExpected: HOOK_EVENTS.length,
    statusline: isOurStatusLine(settings.statusLine),
  };
}
