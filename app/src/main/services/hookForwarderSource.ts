/**
 * Source of the hook forwarder script we drop on disk on first boot.
 *
 * Claude Code invokes each hook as a shell command — the command we
 * register runs this script. It:
 *   1. Reads the hook event JSON from stdin.
 *   2. Forwards it to our main process over a Unix socket.
 *   3. Writes whatever main returns to stdout (Claude reads this to
 *      decide whether to allow/block a tool call).
 *   4. **Times out at 1500 ms** so a dead main process can never freeze
 *      the agent (PRD F2.7 fail-open).
 *
 * The script must be self-contained — Claude executes it without
 * inheriting our app's node_modules. It uses only Node built-ins.
 */

export const HOOK_FORWARDER_SCRIPT = String.raw`#!/usr/bin/env node
'use strict';

const net = require('node:net');
const sockPath = process.env.CODE24_HOOK_SOCK;
const sessionId = process.env.CODE24_SESSION_ID;
const eventName = process.argv[2] || 'unknown';

// If we can't reach main, fall back to empty allow — never freeze Claude.
function failOpen() {
  try { process.stdout.write('{}\n'); } catch (_) {}
  process.exit(0);
}

if (!sockPath || !sessionId) failOpen();

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('error', failOpen);
process.stdin.on('end', () => {
  let body;
  try { body = stdin ? JSON.parse(stdin) : {}; }
  catch (_) { body = { raw: stdin }; }

  const payload = { sessionId, event: eventName, body };
  let response = '';
  let resolved = false;
  const sock = net.createConnection(sockPath);

  const finish = (text) => {
    if (resolved) return;
    resolved = true;
    try { sock.destroy(); } catch (_) {}
    try { process.stdout.write((text && text.length ? text : '{}') + (text && text.endsWith('\n') ? '' : '\n')); } catch (_) {}
    process.exit(0);
  };

  const timer = setTimeout(() => finish(''), 1500);

  sock.once('connect', () => {
    sock.write(JSON.stringify(payload) + '\n');
  });
  sock.on('data', (b) => { response += b.toString('utf8'); });
  sock.on('end', () => { clearTimeout(timer); finish(response); });
  sock.on('error', () => { clearTimeout(timer); finish(''); });
});
`;
