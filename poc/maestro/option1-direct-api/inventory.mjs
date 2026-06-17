#!/usr/bin/env node
// poc/maestro/inventory.mjs
//
// Read the live baton state from ~/.baton/baton.db and the
// per-session scrollback under ~/.baton/scrollback/, then emit
// a single JSON object that matches the input shape documented in
// prompts/planner.system.md.
//
// Usage:
//   node poc/maestro/inventory.mjs               # write JSON to stdout
//   node poc/maestro/inventory.mjs --pretty      # human-readable
//
// Usage % comes from env (USAGE_5H, USAGE_7D as 0..1 floats) because
// the OAuth path is owned by the running baton process; this PoC
// stays out of its way.
//
// Reads via the `sqlite3` CLI so the PoC has zero npm deps.
//
// SAFE: reads only. No mutations to db, sessions, worktrees, or git.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BATON_DIR = process.env.BATON_DIR ?? join(homedir(), '.baton');
const DB_PATH = join(BATON_DIR, 'baton.db');
const SCROLLBACK_DIR = join(BATON_DIR, 'scrollback');
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const SCROLLBACK_TAIL_BYTES = 2048;
const TRANSCRIPT_TAIL_LINES = 20;
const JSONL_TURNS = 4;          // last N turns to surface to the planner
const JSONL_CONTENT_CAP = 600;  // per-block content cap, chars

// Cross-tick cursor: the (session id → last_activity_at) we emitted on
// the previous tick. When a session's activity timestamp hasn't moved,
// the master already saw the same tail in its memory — we elide the
// conversation block down to a `source: 'unchanged'` stub so the
// inventory stays compact and the master leans on its memory instead
// of re-reading identical bytes.
const CURSOR_FILE = join(BATON_DIR, 'maestro', 'inventory-cursor.json');

function sqliteJson(sql) {
  const out = execFileSync(
    'sqlite3',
    ['-readonly', '-json', DB_PATH, sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
  return out ? JSON.parse(out) : [];
}

function readUsage() {
  const fiveH = Number.parseFloat(process.env.USAGE_5H ?? 'NaN');
  const sevenD = Number.parseFloat(process.env.USAGE_7D ?? 'NaN');
  return {
    usage_pct_5h: Number.isFinite(fiveH) ? fiveH : null,
    usage_pct_7d: Number.isFinite(sevenD) ? sevenD : null,
    source: Number.isFinite(fiveH) ? 'env' : 'unset'
  };
}

// Sanitize a cwd the same way Claude Code does for its projects dir.
// Source: sessionManager.ts transcriptExistsFor — `/[/._]/g → '-'`.
function sanitizeCwd(cwd) {
  return cwd.replace(/[/._]/g, '-');
}

// Cross-tick cursor I/O. Returns an object keyed by session id with
// the previously-emitted last_activity_at ISO string. Missing file →
// empty map (first tick after install / --reset).
function readCursor() {
  try {
    if (!existsSync(CURSOR_FILE)) return {};
    return JSON.parse(readFileSync(CURSOR_FILE, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function writeCursor(cursor) {
  try {
    mkdirSync(join(BATON_DIR, 'maestro'), { recursive: true });
    writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 2));
  } catch {
    // Cursor is opportunistic — failure here just means we'll re-send
    // the full tail next tick. Don't fail the inventory call.
  }
}

// Determine when a session "last did something" — used for the
// unchanged-since-last-tick elision. Prefers the JSONL mtime (real
// agent activity); falls back to scrollback mtime for shells / agents
// without a captured claude_session_id; finally to the row's started_at
// as a safe floor so the cursor always has a stable comparator.
function lastActivityIso(session) {
  if (session.backend_id === 'claude-code' && session.claude_session_id) {
    const sanitized = sanitizeCwd(session.worktree_path);
    const jsonl = join(CLAUDE_PROJECTS_DIR, sanitized, `${session.claude_session_id}.jsonl`);
    if (existsSync(jsonl)) {
      try { return new Date(statSync(jsonl).mtimeMs).toISOString(); }
      catch { /* fall through */ }
    }
  }
  const scrollback = join(SCROLLBACK_DIR, `${session.id}.bin`);
  if (existsSync(scrollback)) {
    try { return new Date(statSync(scrollback).mtimeMs).toISOString(); }
    catch { /* fall through */ }
  }
  return new Date(session.started_at).toISOString();
}

// Read the last `JSONL_TURNS` turns of Claude Code's own conversation
// log for a session. Returns `{ source: 'jsonl', turns: [...] }` on
// success or null if the file is missing / unreadable. Each turn:
//   { role, blocks: [{ kind, text }] }
// where kind ∈ {"text", "tool_use:Name", "tool_result", "thinking"}.
function readClaudeJsonlTail(cwd, claudeSessionId) {
  if (!claudeSessionId) return null;
  const sanitized = sanitizeCwd(cwd);
  const p = join(CLAUDE_PROJECTS_DIR, sanitized, `${claudeSessionId}.jsonl`);
  if (!existsSync(p)) return null;
  let lines;
  try {
    // For most sessions this file is well under 10 MB. Read fully and
    // slice; if it ever gets huge we can switch to a reverse-scanner.
    lines = readFileSync(p, 'utf8').split('\n').filter((l) => l);
  } catch {
    return null;
  }
  const recent = lines.slice(-JSONL_TURNS * 3); // 3× to cover tool_use/result pairs
  const turns = [];
  for (const line of recent) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj.message;
    if (!msg || !msg.role) continue;
    const blocks = [];
    const content = Array.isArray(msg.content)
      ? msg.content
      : typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : [];
    for (const c of content) {
      if (c.type === 'text' && c.text) {
        blocks.push({ kind: 'text', text: c.text.slice(0, JSONL_CONTENT_CAP) });
      } else if (c.type === 'tool_use') {
        const name = c.name ?? '?';
        const args = JSON.stringify(c.input ?? {}).slice(0, 200);
        blocks.push({ kind: `tool_use:${name}`, text: args });
      } else if (c.type === 'tool_result') {
        const t = typeof c.content === 'string'
          ? c.content
          : JSON.stringify(c.content ?? '');
        blocks.push({ kind: 'tool_result', text: t.slice(0, JSONL_CONTENT_CAP) });
      } else if (c.type === 'thinking') {
        // Don't ship raw thinking to the planner — too noisy, big.
        blocks.push({ kind: 'thinking', text: '<elided>' });
      }
    }
    if (blocks.length) turns.push({ role: msg.role, blocks });
  }
  if (!turns.length) return null;
  return { source: 'jsonl', turns: turns.slice(-JSONL_TURNS) };
}

function readScrollbackTail(sessionId) {
  const p = join(SCROLLBACK_DIR, `${sessionId}.bin`);
  if (!existsSync(p)) return null;
  const sz = statSync(p).size;
  const offset = Math.max(0, sz - SCROLLBACK_TAIL_BYTES);
  const buf = readFileSync(p);
  const slice = buf.subarray(offset);
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
  const text = slice.toString('utf8').replace(ansi, '');
  const lines = text.split(/\r?\n/).slice(-TRANSCRIPT_TAIL_LINES);
  return lines.join('\n').slice(-2000);
}

function readBacklog(projectPath) {
  const p = join(projectPath, '.baton', 'backlog.md');
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  const items = [];
  let inTodo = false;
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(\w+)/);
    if (heading) {
      inTodo = heading[1].toUpperCase() === 'TODO';
      continue;
    }
    if (!inTodo) continue;
    const item = line.match(/^\s*-\s+\[\s\]\s+(.+)$/);
    if (item) items.push(item[1].trim());
  }
  return items;
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`No baton.db at ${DB_PATH}`);
    process.exit(2);
  }

  const projects = sqliteJson(
    `SELECT id, name, path, snoozed_at FROM projects
     WHERE connection_id = 'local'`
  );
  const projectsById = new Map(projects.map((p) => [p.id, p]));

  const sessions = sqliteJson(
    `SELECT id, project_id, backend_id, branch, worktree_path, status,
            intent_label, tokens_in, tokens_out, last_summary,
            started_at, snoozed_at, claude_session_id, session_kind
     FROM sessions
     WHERE ended_at IS NULL`
  );

  const now = Date.now();
  const prevCursor = readCursor();
  const nextCursor = {};
  const sessionRows = sessions.map((s) => {
    const project = projectsById.get(s.project_id);
    const lastActivityAt = lastActivityIso(s);
    nextCursor[s.id] = lastActivityAt;
    const unchanged = prevCursor[s.id] === lastActivityAt;

    // Prefer Claude Code's own structured conversation log for
    // claude-code sessions. Scrollback is a noisy TUI buffer; the
    // JSONL is the actual turn-by-turn record. Fall back to scrollback
    // when no claude_session_id is captured yet, when the file is
    // missing, or for non-claude backends (codex, shell).
    //
    // Elision: if the activity timestamp hasn't moved since last
    // tick, the master saw this exact tail before — emit a stub so
    // it leans on its memory instead. Saves ~99% of the bytes for
    // quiet sessions while keeping the structural slot in place.
    let conversation = null;
    if (unchanged) {
      conversation = { source: 'unchanged', last_activity_at: lastActivityAt };
    } else if (s.backend_id === 'claude-code' && s.claude_session_id) {
      conversation = readClaudeJsonlTail(s.worktree_path, s.claude_session_id);
    }
    if (!conversation) {
      const tail = readScrollbackTail(s.id);
      if (tail) conversation = { source: 'scrollback', tail };
    }
    return {
      id: s.id,
      project_id: s.project_id,
      project_name: project?.name ?? '<unknown>',
      backend: s.backend_id,
      branch: s.branch,
      worktree_path: s.worktree_path,
      status: s.status,
      intent_label: s.intent_label,
      tokens_total: (s.tokens_in ?? 0) + (s.tokens_out ?? 0),
      minutes_since_started: Math.round((now - s.started_at) / 60000),
      last_summary: s.last_summary,
      snoozed: s.snoozed_at != null || project?.snoozed_at != null,
      session_kind: s.session_kind ?? 'agent',
      last_activity_at: lastActivityAt,
      conversation
    };
  });

  writeCursor(nextCursor);

  const backlogs = {};
  for (const p of projects) {
    if (!p.path.startsWith('/')) continue;
    const items = readBacklog(p.path);
    if (items && items.length) backlogs[p.id] = items;
  }

  const usage = readUsage();
  const out = {
    now: new Date(now).toISOString(),
    usage_pct_5h: usage.usage_pct_5h,
    usage_pct_7d: usage.usage_pct_7d,
    usage_source: usage.source,
    active_session_count: sessionRows.length,
    sessions: sessionRows,
    backlogs
  };

  const pretty = process.argv.includes('--pretty');
  process.stdout.write(JSON.stringify(out, null, pretty ? 2 : 0));
  process.stdout.write('\n');
}

main();
