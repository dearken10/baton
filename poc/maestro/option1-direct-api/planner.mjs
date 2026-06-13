#!/usr/bin/env node
// poc/maestro/planner.mjs
//
// Read an inventory JSON object on stdin, build a planner prompt
// against prompts/planner.system.md, and call Claude Haiku 4.5 via
// the Messages API. Print the planner's JSON response on stdout.
//
// Usage:
//   node poc/maestro/inventory.mjs | node poc/maestro/planner.mjs
//   node poc/maestro/planner.mjs --dry  # print the prompt, don't call
//   node poc/maestro/planner.mjs --in inventory.json
//
// Requires ANTHROPIC_API_KEY in env (unless --dry).
//
// Uses node:https directly — no npm install needed.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { request } from 'node:https';

const KEYCHAIN_SERVICES = ['Claude Code-credentials', 'Claude Code'];

// Mirror app/src/main/services/claudeUsageApi.ts. Token is read
// ephemerally; never written to disk or stdout.
function readOAuthTokenFromKeychain() {
  if (process.platform !== 'darwin') return null;
  for (const svc of KEYCHAIN_SERVICES) {
    try {
      const out = execSync(
        `security find-generic-password -s ${JSON.stringify(svc)} -w`,
        { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      const tok = JSON.parse(out)?.claudeAiOauth?.accessToken;
      if (tok) return tok;
    } catch { /* try next */ }
  }
  return null;
}
function readOAuthTokenFromFile() {
  try {
    const p = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'))?.claudeAiOauth?.accessToken ?? null;
  } catch { return null; }
}
function readOAuthToken() {
  return readOAuthTokenFromKeychain() ?? readOAuthTokenFromFile();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = join(__dirname, 'prompts/planner.system.md');
const MODEL = process.env.MAESTRO_MODEL ?? 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 3000;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function pickAuth() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return { kind: 'api-key', value: apiKey };
  const oauth = readOAuthToken();
  if (oauth) return { kind: 'oauth', value: oauth };
  throw new Error(
    'No credentials. Set ANTHROPIC_API_KEY, or log in to Claude Code so ' +
      '~/.claude/.credentials.json / keychain has a token.'
  );
}

async function callAnthropic({ system, userJson }) {
  const auth = pickAuth();
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    system: [
      // Prompt caching: the system prompt rarely changes; mark it so
      // repeated ticks within 5 min cost 10% of the first call.
      { type: 'text', text: system, cache_control: { type: 'ephemeral' } }
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Maestro inventory follows. Return the JSON plan only.\n\n' +
              userJson
          }
        ]
      }
    ]
  });
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01'
  };
  if (auth.kind === 'api-key') {
    headers['x-api-key'] = auth.value;
    headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
  } else {
    // OAuth path: the same Bearer token Claude Code uses. The
    // oauth-2025-04-20 beta gates first-party OAuth on /v1/messages.
    headers['authorization'] = `Bearer ${auth.value}`;
    headers['anthropic-beta'] =
      'oauth-2025-04-20,prompt-caching-2024-07-31';
  }
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: 'POST',
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        headers
      },
      (res) => {
        const bufs = [];
        res.on('data', (c) => bufs.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(bufs).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${txt}`));
            return;
          }
          resolve(JSON.parse(txt));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractPlannerJson(apiResponse) {
  const text = apiResponse.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  // The model may still wrap in ```json fences despite the prompt.
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const raw = fenced ? fenced[1] : text;
  try {
    return JSON.parse(raw.trim());
  } catch (e) {
    throw new Error(`Planner returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isDry = args.includes('--dry');
  const inIdx = args.indexOf('--in');
  let inventoryJson;
  if (inIdx >= 0) {
    inventoryJson = readFileSync(args[inIdx + 1], 'utf8');
  } else {
    inventoryJson = await readStdin();
  }
  if (!inventoryJson.trim()) {
    console.error(
      'No inventory on stdin. Pipe `node inventory.mjs` into me.'
    );
    process.exit(2);
  }
  const system = readFileSync(SYSTEM_PROMPT_PATH, 'utf8');

  if (isDry) {
    console.error('=== SYSTEM PROMPT ===');
    console.error(system);
    console.error('\n=== USER INPUT (inventory) ===');
    console.error(inventoryJson.slice(0, 4000));
    console.error('\n=== MODEL ===');
    console.error(MODEL);
    return;
  }

  const resp = await callAnthropic({ system, userJson: inventoryJson });
  const plan = extractPlannerJson(resp);

  const usage = resp.usage ?? {};
  console.error(
    `[planner] in=${usage.input_tokens ?? '?'} ` +
      `cache_read=${usage.cache_read_input_tokens ?? 0} ` +
      `cache_create=${usage.cache_creation_input_tokens ?? 0} ` +
      `out=${usage.output_tokens ?? '?'} ` +
      `model=${MODEL}`
  );
  process.stdout.write(JSON.stringify(plan, null, 2));
  process.stdout.write('\n');
}

main().catch((e) => {
  console.error('[planner] error:', e.message);
  process.exit(1);
});
