import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_PORT = 4317;

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function buddyDir() {
  return process.env.DESK_BUDDY_HOME || path.join(os.homedir(), '.desk-buddy');
}

export function configPath() {
  return path.join(buddyDir(), 'config.json');
}

// Short token so the URL is easy to type on a phone. 8 chars of base32 = 40 bits,
// plenty for a LAN-only, display-only page.
function newToken() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function loadConfig({ create = true } = {}) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    // missing or unreadable: fall through to defaults
  }
  let changed = false;
  if (!Number.isInteger(cfg.port)) { cfg.port = DEFAULT_PORT; changed = true; }
  if (typeof cfg.token !== 'string' || cfg.token.length < 6) { cfg.token = newToken(); changed = true; }
  if (changed && create) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(buddyDir(), { recursive: true });
  // Atomic, so the server (which rereads it) never sees half a file; 600, since it holds keys.
  const file = configPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
