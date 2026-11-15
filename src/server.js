import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuddyState } from './state.js';
import { UsageTracker } from './usage.js';
import { claudeDir } from './config.js';
import { startDemo } from './demo.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const MAX_BODY = 2 * 1024 * 1024;
const USAGE_REFRESH_MS = 20_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const tailscale = a.address.startsWith('100.') || /tailscale|utun/i.test(name);
      out.push({ name, address: a.address, tailscale });
    }
  }
  // Prefer ordinary LAN addresses first; Tailscale is a nice fallback.
  return out.sort((x, y) => Number(x.tailscale) - Number(y.tailscale));
}

export function startServer({ port, token, host = '0.0.0.0', log = console.log, demo = false }) {
  const state = new BuddyState();
  const usage = new UsageTracker(path.join(claudeDir(), 'projects'));
  const clients = new Set();
  let pending = null;

  let demoRun = null;
  const snapshot = () => ({
    ...state.snapshot(),
    usage: demoRun ? demoRun.usage() : usage.snapshot(),
    demo: Boolean(demoRun),
  });

  const broadcast = () => {
    if (pending) return;
    // Coalesce bursts (a tool batch fires many hooks in a few ms).
    pending = setTimeout(() => {
      pending = null;
      const data = `data: ${JSON.stringify(snapshot())}\n\n`;
      for (const res of clients) res.write(data);
    }, 80);
  };

  const refreshUsage = () => {
    if (demoRun) return;
    try { if (usage.refresh()) broadcast(); } catch (e) { log(`usage: ${e.message}`); }
  };
  if (demo) demoRun = startDemo({ state, onChange: () => broadcast() });
  refreshUsage();
  const usageTimer = setInterval(refreshUsage, USAGE_REFRESH_MS);
  const tickTimer = setInterval(() => { if (state.tick()) broadcast(); }, 1000);
  const pingTimer = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20_000);

  const authed = (req, url) => {
    if (url.searchParams.get('t') === token) return true;
    return parseCookies(req).buddy === token;
  };

  const sendFile = (res, file, extraHeaders = {}) => {
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...extraHeaders,
      });
      res.end(buf);
    });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;

    // ---- Inputs from Claude Code: only accepted from this machine ----
    if (req.method === 'POST' && (p === '/hook' || p === '/status')) {
      if (!isLoopback(req)) { res.writeHead(403); return res.end(); }
      const body = await readBody(req);
      // Answer straight away with a no-op so the hook never slows Claude Code down.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      if (!body) return;
      if (process.env.DESK_BUDDY_DEBUG) log(`${p} ${body.hook_event_name || 'status'} ${body.tool_name || body.notification_type || ''}`);
      const changed = p === '/hook' ? state.applyHook(body) : state.applyStatus(body);
      if (changed) broadcast();
      if (p === '/hook' && (body.hook_event_name === 'Stop' || body.hook_event_name === 'SessionStart')) {
        setTimeout(refreshUsage, 1500); // transcript is written just after Stop
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

    if (p === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, clients: clients.size }));
    }

    // Public static assets (no data in them).
    if (p.startsWith('/static/')) {
      const rel = path.normalize(p.slice('/static/'.length)).replace(/^(\.\.[/\\])+/, '');
      return sendFile(res, path.join(WEB_DIR, rel));
    }

    if (!authed(req, url)) {
      return sendFile(res, path.join(WEB_DIR, 'pair.html'));
    }

    if (p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(snapshot()));
    }

    if (p === '/manifest.webmanifest') {
      // start_url carries the token: iOS home-screen apps don't share cookies with Safari.
      fs.readFile(path.join(WEB_DIR, 'manifest.webmanifest'), 'utf8', (err, txt) => {
        if (err) { res.writeHead(500); return res.end(); }
        const m = JSON.parse(txt);
        m.start_url = `/?t=${token}`;
        res.writeHead(200, { 'Content-Type': MIME['.webmanifest'], 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(m));
      });
      return;
    }

    if (p === '/' || p === '/index.html') {
      fs.readFile(path.join(WEB_DIR, 'index.html'), 'utf8', (err, html) => {
        if (err) { res.writeHead(500); return res.end(); }
        res.writeHead(200, {
          'Content-Type': MIME['.html'],
          'Cache-Control': 'no-store',
          'Set-Cookie': `buddy=${token}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`,
        });
        res.end(html.replaceAll('{{TOKEN}}', token));
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  server.listen(port, host);
  server.on('close', () => {
    clearInterval(usageTimer);
    clearInterval(tickTimer);
    clearInterval(pingTimer);
    if (demoRun) demoRun.stop();
  });
  return { server, state, usage };
}
