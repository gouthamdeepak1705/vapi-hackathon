#!/usr/bin/env node
// Tells the chief of staff that a coding agent needs you. Works as a hook for both agents:
//   Claude Code  (Notification hook): the event arrives as JSON on stdin
//   Codex        (notify setting):    the event arrives as JSON in the last argument
//   by hand:     node scripts/notify-agent.js claude "Which database should I use?" --needs input --project api
// It never fails loudly: if the app is not running it just exits 0 so it cannot block an agent.
const http = require('http');
const path = require('path');

const PORT = Number(process.env.COS_PORT) || 4747;
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const needsFlag = flag('needs'), projectFlag = flag('project');

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let t = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { t += c; }).on('end', () => resolve(t)).on('error', () => resolve(t));
    setTimeout(() => resolve(t), 1500).unref();
  });
}
const parse = (s) => { try { const j = JSON.parse(s); return j && typeof j === 'object' ? j : null; } catch { return null; } };

(async () => {
  let agent = (args[0] || '').toLowerCase(), text = args.slice(1).join(' '), needs = needsFlag, cwd = '';
  const last = args[args.length - 1];
  const fromCodex = parse(last);       // Codex passes its event as the last argument
  const fromClaude = parse(await readStdin()); // Claude Code passes its hook event on stdin

  if (fromCodex && fromCodex.type) {
    agent = 'codex'; cwd = fromCodex.cwd || '';
    text = String(fromCodex['last-assistant-message'] || 'finished a turn');
    needs = needsFlag || (/\?\s*$/.test(text.trim()) ? 'input' : 'done');
  } else if (fromClaude && (fromClaude.hook_event_name || fromClaude.message)) {
    agent = 'claude'; cwd = fromClaude.cwd || '';
    text = String(fromClaude.message || 'needs your attention');
    needs = needsFlag || (/permission/i.test(text) ? 'permission' : fromClaude.hook_event_name === 'Stop' ? 'done' : 'input');
  }
  if (!text.trim()) { console.error('usage: notify-agent.js <claude|codex> "what it needs" [--needs input|permission|error|done] [--project name]'); process.exit(0); }

  const body = JSON.stringify({ type: 'agent', agent, needs, text, project: projectFlag || (cwd ? path.basename(cwd) : '') });
  const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/action', headers: { Host: `localhost:${PORT}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 3000 }, (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.on('error', () => process.exit(0)); req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
})();
