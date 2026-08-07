#!/usr/bin/env node
// poc/maestro/option5-product-manager/pm-propose.mjs
//
// Option 5 — PM-as-outsider architecture.
//
// Where option 4 clones the target agent's JSONL and asks IT to
// reflect on its own conversation, option 5 fires a FRESH claude -p
// session that has never seen this transcript, gives it a Product
// Manager persona via the goal.md prompt, feeds it the user-supplied
// goal + a summary of the target agent's recent turns, and asks: given
// this goal + progress, what should the engineer be told to do next?
//
// The point: a fresh session evaluates the work as an outsider, not
// as the same agent second-guessing itself. Different failure modes,
// probably different suggestions.
//
// Usage:
//   node poc/maestro/option5-product-manager/pm-propose.mjs \
//     <claude-session-id> \
//     [--turns N]           # last N turns to include (default 8)
//     [--jsonl-path PATH]   # explicit path instead of searching
//     [--dry-run]           # print the composed prompt; skip claude call
//     [--prompt PATH]       # use a different template (default: prompts/goal.md)
//
// The goal lives INSIDE prompts/goal.md — edit that file directly to
// change what the PM optimizes for. The script feeds the whole file to
// claude -p on every run, so a save takes effect on the next call.
//
// The <claude-session-id> is the UUID Claude Code assigned to the
// target agent's session (visible in baton's session info dialog and
// as the filename under ~/.claude/projects/<sanitized-cwd>/). We
// search for its JSONL under ~/.claude/projects/*/<uuid>.jsonl unless
// --jsonl-path is passed.
//
// Output on stdout: the same JSON shape as option 4 —
//   { action, prompt, rationale, assumption, if_wrong,
//     reversibility_cost, confidence }
// Progress + errors go to stderr so the script can be piped safely.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HERE = dirname(new URL(import.meta.url).pathname);
const DEFAULT_PROMPT_PATH = join(HERE, 'prompts', 'goal.md');
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Caps to keep the composed prompt from becoming absurd — a hallmark
// of a runaway JSONL is 200 KB of tool-call noise; we cap per-block
// and total so one giant tool result can't crowd out the actual
// conversation.
const DEFAULT_TURNS = 8;
const PER_BLOCK_CHAR_CAP = 800;
const TOTAL_CONVERSATION_CHAR_CAP = 40_000;
const CLAUDE_TIMEOUT_MS = 180_000;

/** Parse argv. Minimal — expects exactly one positional (the claude
 *  session id) and the flags documented above. */
function parseArgs(argv) {
  const out = {
    claudeSessionId: null,
    turns: DEFAULT_TURNS,
    jsonlPath: null,
    dryRun: false,
    promptPath: DEFAULT_PROMPT_PATH,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--turns')      { out.turns = Number.parseInt(argv[++i], 10); continue; }
    if (a === '--jsonl-path') { out.jsonlPath = argv[++i]; continue; }
    if (a === '--dry-run')    { out.dryRun = true; continue; }
    if (a === '--prompt')     { out.promptPath = argv[++i]; continue; }
    if (a.startsWith('--'))   { die(`unknown flag: ${a}`); }
    rest.push(a);
  }
  if (rest.length !== 1) die('usage: pm-propose.mjs <claude-session-id> [flags]');
  out.claudeSessionId = rest[0];
  if (!Number.isFinite(out.turns) || out.turns <= 0) out.turns = DEFAULT_TURNS;
  return out;
}

function die(msg) {
  console.error(msg);
  process.exit(64);
}

/** Locate <uuid>.jsonl anywhere under ~/.claude/projects/. Returns
 *  the absolute path or null. The projects dir is shallow (one
 *  subdirectory per sanitized-cwd), so a single readdir on each is
 *  cheap enough. */
function findJsonl(uuid, explicitPath) {
  if (explicitPath) {
    return existsSync(explicitPath) ? explicitPath : null;
  }
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;
  const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
  for (const projectDir of projectDirs) {
    const candidate = join(CLAUDE_PROJECTS_DIR, projectDir, `${uuid}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Read the JSONL and emit a chronological array of turns. Each row
 *  in Claude Code's transcript is one line of JSON; only `message`
 *  entries carry user/assistant turns (we skip meta rows — attachments,
 *  queue ops, title generation).
 *
 *  Assistant blocks other than text are collapsed to short markers so
 *  the PM sees WHAT the engineer did without drowning in tool payloads. */
function readTurns(jsonlPath, tailN) {
  const raw = readFileSync(jsonlPath, 'utf8');
  const lines = raw.split('\n');
  const turns = [];
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const msg = obj.message;
    if (!msg || typeof msg !== 'object') continue;
    const role = obj.type;
    const blocks = normalizeBlocks(msg.content, role);
    if (blocks.length === 0) continue;
    turns.push({ role, blocks, ts: obj.timestamp ?? null });
  }
  return turns.slice(-tailN);
}

function normalizeBlocks(content, role) {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', text: cap(content) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.length > 0) out.push({ kind: 'text', text: cap(block) });
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.length > 0) out.push({ kind: 'text', text: cap(block.text) });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      // Skip thinking blocks — the PM shouldn't try to unpack the
      // engineer's inner monologue; the visible message is what
      // matters for the decision.
      continue;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      out.push({ kind: 'tool', text: `[tool_use: ${block.name}]` });
    } else if (block.type === 'tool_result') {
      const preview = cap(previewToolResult(block.content));
      const errFlag = block.is_error ? ' (error)' : '';
      out.push({ kind: 'tool', text: `[tool_result${errFlag}] ${preview}` });
    }
    if (role !== role) { /* placate no-unused-vars */ }
  }
  return out;
}

function previewToolResult(content) {
  if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim();
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && typeof b.text === 'string') return b.text;
        return '';
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text.replace(/\s+/g, ' ').trim();
  }
  try { return JSON.stringify(content).replace(/\s+/g, ' ').trim(); }
  catch { return String(content); }
}

function cap(s) {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > PER_BLOCK_CHAR_CAP
    ? flat.slice(0, PER_BLOCK_CHAR_CAP) + '…'
    : flat;
}

/** Render the turn list as plain text the PM prompt can splice in.
 *  Enforces the total conversation cap by dropping oldest turns first
 *  until we fit — the tail is the most decision-relevant. */
function formatConversation(turns) {
  const lines = [];
  let bytes = 0;
  // Oldest first, so newest turns win when we truncate.
  const rendered = turns.map((t) => {
    const body = t.blocks.map((b) => b.text).join('\n');
    return `${t.role}:\n${body}`;
  });
  // Walk from the tail; keep prepending until we hit the cap.
  const keep = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    const chunk = rendered[i];
    if (bytes + chunk.length + 2 > TOTAL_CONVERSATION_CHAR_CAP) break;
    keep.unshift(chunk);
    bytes += chunk.length + 2;
  }
  const droppedCount = rendered.length - keep.length;
  if (droppedCount > 0) {
    lines.push(`[…elided ${droppedCount} older turn(s) to stay under the ${TOTAL_CONVERSATION_CHAR_CAP}-char cap]`);
    lines.push('');
  }
  return [lines.join('\n'), keep.join('\n\n---\n\n')].filter(Boolean).join('');
}

/** Render "how long since the last conversation turn" in a form the
 *  PM can reason about — "18m ago (ISO)". Handles rows with no
 *  timestamp (older JSONL formats) and unparseable strings. Used by
 *  the {{LAST_UPDATE}} placeholder so a prompt that gates on idle
 *  time ("follow up after 15 min") has the data it needs. */
function formatLastUpdate(turns) {
  if (turns.length === 0) return 'unknown (no turns read)';
  const last = turns[turns.length - 1];
  if (!last.ts) return 'unknown (last turn has no timestamp)';
  const t = Date.parse(last.ts);
  if (!Number.isFinite(t)) return `unknown (unparseable: ${last.ts})`;
  return `${fmtElapsed(Date.now() - t)} (${new Date(t).toISOString()})`;
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}h ${mm}m ago`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return `${d}d ${hh}h ago`;
}

/** Substitute {{CONVERSATION}} + {{LAST_UPDATE}} in the template. The
 *  goal itself lives directly in goal.md — the user edits it there
 *  and saves; we don't substitute anything for it. Warn if the
 *  CONVERSATION placeholder is missing since that would silently
 *  break the "PM sees engineer's tail" behavior; a missing
 *  LAST_UPDATE is only a warning too, since the timing check is
 *  optional. */
function composePrompt(template, conversation, lastUpdate) {
  if (!template.includes('{{CONVERSATION}}')) {
    console.error('[pm] warning: prompt template has no {{CONVERSATION}} placeholder — the engineer\'s conversation will not be included');
  }
  if (!template.includes('{{LAST_UPDATE}}')) {
    console.error('[pm] note: prompt template has no {{LAST_UPDATE}} placeholder — PM will not know the idle time');
  }
  return template
    .split('{{CONVERSATION}}').join(conversation)
    .split('{{LAST_UPDATE}}').join(lastUpdate);
}

/** Fire claude -p with the composed prompt. cwd = HOME so claude
 *  doesn't attach to a specific project's setup script or MCP config
 *  by accident. `--dangerously-skip-permissions` because we're
 *  print-mode + the prompt itself is propose-only (no tool calls
 *  requested). */
function runClaude(prompt) {
  const res = spawnSync(
    'claude',
    ['-p', prompt, '--dangerously-skip-permissions'],
    {
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: CLAUDE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (res.error) throw new Error(`spawn error: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`claude exited ${res.status}\n${(res.stderr ?? '').trim()}`);
  }
  return (res.stdout ?? '').trim();
}

/** Pull the JSON object out of claude's stdout. The prompt asks for a
 *  bare JSON response, but claude occasionally wraps in a fence or
 *  adds a preamble — be forgiving. */
function extractJson(stdout) {
  let s = stdout.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) {
    throw new Error(`no JSON object in response:\n${stdout.slice(0, 500)}`);
  }
  return JSON.parse(s.slice(first, last + 1));
}

// ────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));

  const jsonlPath = findJsonl(args.claudeSessionId, args.jsonlPath);
  if (!jsonlPath) {
    die(
      `no JSONL found for ${args.claudeSessionId}. ` +
      `Searched ${CLAUDE_PROJECTS_DIR}/*/${args.claudeSessionId}.jsonl. ` +
      `Pass --jsonl-path <path> if it's elsewhere.`
    );
  }
  const size = statSync(jsonlPath).size;
  console.error(`[pm] jsonl: ${jsonlPath} (${size} bytes)`);

  const turns = readTurns(jsonlPath, args.turns);
  console.error(`[pm] read ${turns.length} turn(s) from tail`);

  const template = readFileSync(args.promptPath, 'utf8');
  const conversation = formatConversation(turns);
  const lastUpdate = formatLastUpdate(turns);
  const prompt = composePrompt(template, conversation, lastUpdate);

  if (args.dryRun) {
    process.stdout.write(prompt);
    process.stdout.write('\n');
    console.error(`[pm] dry-run: composed prompt is ${prompt.length} chars, skipping claude call`);
    return;
  }

  console.error('[pm] calling claude…');
  const raw = runClaude(prompt);
  const proposal = extractJson(raw);
  const out = {
    claude_session_id: args.claudeSessionId,
    jsonl_path: jsonlPath,
    prompt_path: args.promptPath,
    turn_count_used: turns.length,
    proposal,
  };
  process.stdout.write(JSON.stringify(out, null, 2));
  process.stdout.write('\n');
}

try { main(); }
catch (e) {
  console.error(`[pm] FAILED: ${(e instanceof Error) ? e.message : String(e)}`);
  process.exit(1);
}
