#!/usr/bin/env node
// desk-buddy status line bridge.
// Claude Code pipes session JSON (incl. rate_limits) into the status line command.
// We forward it to the local desk-buddy server, then print either your original
// status line (if you had one) or a compact default line.
// Self-contained on purpose: it is copied to ~/.desk-buddy/ and must not depend on the package.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const home = process.env.DESK_BUDDY_HOME || path.join(os.homedir(), '.desk-buddy');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch { /* defaults */ }
const port = cfg.port || 4317;

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const raw = Buffer.concat(chunks);
  await Promise.all([forward(raw), render(raw)]);
});

function forward(raw) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/status', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': raw.length },
      timeout: 400,
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', resolve); // server not running: that's fine
    req.end(raw);
  });
}

function render(raw) {
  const wrapped = cfg.wrappedStatusLine;
  if (wrapped && wrapped.command) {
    return new Promise((resolve) => {
      const child = spawn(wrapped.command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
      child.on('error', resolve);
      child.on('close', resolve);
      child.stdin.on('error', () => {});
      child.stdin.end(raw);
    });
  }
  let d = {};
  try { d = JSON.parse(raw.toString('utf8')); } catch { /* print nothing useful */ }
  const parts = [];
  if (d.model?.display_name) parts.push(d.model.display_name);
  const ctx = d.context_window?.used_percentage;
  if (typeof ctx === 'number') parts.push(`ctx ${Math.round(ctx)}%`);
  const fh = d.rate_limits?.five_hour?.used_percentage;
  if (typeof fh === 'number') parts.push(`5h ${Math.round(fh)}%`);
  const wk = d.rate_limits?.seven_day?.used_percentage;
  if (typeof wk === 'number') parts.push(`7d ${Math.round(wk)}%`);
  process.stdout.write(parts.join(' · ') + '\n');
  return Promise.resolve();
}
