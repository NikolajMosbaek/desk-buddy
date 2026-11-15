#!/usr/bin/env node
import { loadConfig, saveConfig, configPath } from '../src/config.js';
import { startServer, lanAddresses } from '../src/server.js';
import { install, uninstall, installStatus } from '../src/install.js';
import { renderQR, qrWidth } from '../src/qr.js';

const args = process.argv.slice(2);
const cmd = args.includes('--help') || args.includes('-h') ? 'help' : (args[0] && !args[0].startsWith('-') ? args[0] : 'start');
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function urls(cfg) {
  const list = lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${cfg.port}/?t=${cfg.token}` }));
  return { local: `http://localhost:${cfg.port}/?t=${cfg.token}`, list };
}

function printUrls(cfg) {
  const u = urls(cfg);
  console.log('\nOpen one of these on your phone (same Wi-Fi, or Tailscale):');
  if (!u.list.length) console.log('  (no network interfaces found)');
  for (const a of u.list) console.log(`  ${a.url}${a.tailscale ? '   (Tailscale)' : `   (${a.name})`}`);
  // A QR code for the first (preferred) address: point the phone's camera at it.
  const qrHost = opt('qr-host');
  const target = qrHost ? { address: qrHost, url: `http://${qrHost}:${cfg.port}/?t=${cfg.token}` } : u.list[0];
  if (target && process.stdout.isTTY && !flag('no-qr')) {
    const cols = process.stdout.columns;
    if (cols && cols < qrWidth(target.url)) {
      console.log(`\n(Widen the terminal to ${qrWidth(target.url)} columns to see a QR code.)`);
    } else {
      console.log(`\nScan with the phone's camera (${target.address}):\n`);
      console.log(renderQR(target.url));
    }
  }
  console.log(`\nOn this computer: ${u.local}`);
  console.log('Then on the phone: Share > Add to Home Screen.\n');
}

function help() {
  console.log(`desk-buddy: a desk companion for Claude Code

Usage:
  desk-buddy install [--no-statusline]   Add hooks (and the status line bridge) to ~/.claude/settings.json
  desk-buddy [start] [--port N]          Run the server the phone connects to
  desk-buddy demo [--port N]             Try it without Claude Code: plays a scripted session in a loop
  desk-buddy url                         Print the phone URL again
  desk-buddy status                      Show what is installed
  desk-buddy uninstall                   Remove everything desk-buddy added to settings.json
  desk-buddy new-token                   Rotate the access token (re-open the link on the phone)

Add --no-qr to skip the QR code, or --qr-host <ip> to put another address in it.
`);
}

try {
  switch (cmd) {
    case 'install': {
      if (opt('port')) { const c = loadConfig(); c.port = Number(opt('port')); saveConfig(c); }
      const cfg = install({ statusline: !flag('no-statusline') });
      console.log('\nDone. Restart running Claude Code sessions so they pick up the hooks.');
      console.log('Next: run `desk-buddy` (or `npx github:NikolajMosbaek/desk-buddy`) to start the server.');
      printUrls(cfg);
      break;
    }
    case 'uninstall':
      uninstall();
      break;
    case 'status': {
      const s = installStatus();
      console.log(`settings:   ${s.settingsFile}`);
      console.log(`hooks:      ${s.hooks}/${s.hooksExpected}`);
      console.log(`statusline: ${s.statusline ? 'bridge installed' : 'not installed (no live 5h/7d limits)'}`);
      console.log(`config:     ${configPath()}`);
      break;
    }
    case 'url':
      printUrls(loadConfig());
      break;
    case 'new-token': {
      const c = loadConfig();
      delete c.token;
      saveConfig(c);
      printUrls(loadConfig());
      break;
    }
    case 'demo':
    case 'start': {
      const demo = cmd === 'demo' || flag('demo');
      const cfg = loadConfig();
      const port = opt('port') ? Number(opt('port')) : cfg.port;
      if (port !== cfg.port && !demo) {
        console.log(`Note: hooks were installed for port ${cfg.port}. Run \`desk-buddy install --port ${port}\` to move them.`);
      }
      const s = installStatus();
      if (!s.hooks && !demo) console.log('Hooks are not installed yet, so the buddy will just sleep. Run `desk-buddy install` first.');
      const { server, stats } = startServer({ port, token: cfg.token, demo });
      server.on('listening', () => {
        console.log(demo
          ? `desk-buddy DEMO is running on port ${port}: a scripted session plays in a loop. Claude Code is not needed.`
          : `desk-buddy is running on port ${port}.`);
        printUrls({ ...cfg, port });
      });
      server.on('error', (e) => {
        console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use. Is desk-buddy already running?` : e.message);
        process.exit(1);
      });
      const stop = () => { stats.flush(); server.close(); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      process.on('SIGHUP', stop); // terminal closed
      break;
    }
    case 'help':
    case '--help':
      help();
      break;
    default:
      help();
      process.exitCode = 1;
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
