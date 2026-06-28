#!/usr/bin/env node
// poc/maestro/option4-per-session-clone/propose-for-session.mjs
//
// Take a baton session id → clone its Claude Code JSONL transcript
// with a fresh UUID → run `claude --resume <clone> --print` with the
// Maestro reflection prompt → parse the JSON response → clean up the
// clone. Print the proposal to stdout.
//
// Usage:
//   node poc/maestro/option4-per-session-clone/propose-for-session.mjs <baton-session-id>
//   node ... --prompt <path>  # use a different prompt file (default: prompts/next-action.md)
//   node ... --keep-clone     # leave the clone JSONL on disk for inspection
//   node ... --dry-run        # do everything except the claude call (echo the path of the clone)
//
// The clone lives at:
//   ~/.claude/projects/<sanitized-worktree>/<new-uuid>.jsonl
// where <sanitized-worktree> matches the target agent's worktree, so
// `claude --resume <new-uuid>` (when run from that worktree) finds it.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// BATON_HOME aligns with the Electron app + maestrod daemon's
// instance-isolation env. BATON_DIR stays as a legacy alias for any
// stand-alone callers that already set it.
const BATON_DIR = process.env.BATON_HOME ?? process.env.BATON_DIR ?? join(homedir(), '.baton');
const DB_PATH = join(BATON_DIR, 'baton.db');
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const HERE = dirname(import.meta.url.replace('file://', ''));
const DEFAULT_PROMPT_PATH = join(HERE, 'prompts', 'next-action.md');

/** Match Claude Code's `~/.claude/projects/` naming: `/`, `.`, `_` → `-`. */
function sanitizeCwd(cwd) {
  return cwd.replace(/[/._]/g, '-');
}

function sqliteJson(sql) {
  const out = execFileSync(
    'sqlite3',
    ['-readonly', '-json', DB_PATH, sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
  return out ? JSON.parse(out) : [];
}

function lookupSession(batonId) {
  const rows = sqliteJson(
    `SELECT id, project_id, backend_id, branch, worktree_path,
            status, claude_session_id, last_summary
       FROM sessions WHERE id = '${batonId.replace(/'/g, "''")}'`
  );
  return rows[0] ?? null;
}

/** Copy the source JSONL with a fresh session id rewritten on every
 *  row that carries one. Returns the new uuid + the clone's path on
 *  disk. The clone lives in the SAME projects subdirectory as the
 *  source so `claude --resume <uuid>` finds it when run from the
 *  agent's worktree. */
function cloneJsonl(srcPath, worktreePath) {
  const newUuid = randomUUID();
  const cloneDir = join(CLAUDE_PROJECTS_DIR, sanitizeCwd(worktreePath));
  mkdirSync(cloneDir, { recursive: true });
  const dstPath = join(cloneDir, `${newUuid}.jsonl`);

  const raw = readFileSync(srcPath, 'utf8');
  const rewritten = raw
    .split('\n')
    .map((line) => {
      if (!line) return line;
      try {
        const o = JSON.parse(line);
        if (typeof o.sessionId === 'string') o.sessionId = newUuid;
        return JSON.stringify(o);
      } catch {
        // Non-JSON line — pass through unchanged.
        return line;
      }
    })
    .join('\n');
  writeFileSync(dstPath, rewritten);
  return { newUuid, dstPath };
}

/** Pull the assistant's JSON proposal out of claude's stdout. The
 *  prompt asks for "no markdown fence, no prose" but models
 *  occasionally still wrap. Strip a ```json … ``` fence if present;
 *  fall back to the first {..} block we can match. */
function extractProposal(rawOutput) {
  let s = rawOutput.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) s = fence[1].trim();
  // If the model added any leading/trailing prose, find the first
  // balanced JSON object.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(`could not parse JSON proposal: ${e.message}\n--- raw output ---\n${rawOutput}`);
  }
}

/** Run claude in resume mode against the clone JSONL. Returns the
 *  raw stdout — caller is responsible for extracting the JSON. */
function runClaude({ cloneUuid, worktreePath, promptText, timeoutMs = 180_000 }) {
  // --dangerously-skip-permissions because we explicitly tell the
  // model not to call tools; but in case it tries, we don't want it
  // to hang on a permission prompt in print mode.
  const res = spawnSync(
    'claude',
    ['--resume', cloneUuid, '-p', promptText, '--dangerously-skip-permissions'],
    {
      cwd: worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: timeoutMs,
    }
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `claude exited ${res.status}\nstderr: ${(res.stderr ?? '').trim()}\nstdout: ${(res.stdout ?? '').trim()}`
    );
  }
  return res.stdout ?? '';
}

function main() {
  const args = process.argv.slice(2);
  const keepClone = args.includes('--keep-clone');
  const dryRun = args.includes('--dry-run');
  // --prompt takes the next positional argument as its value
  const promptIdx = args.indexOf('--prompt');
  const promptPath = promptIdx >= 0 ? args[promptIdx + 1] : DEFAULT_PROMPT_PATH;
  // First non-flag, non-flag-arg positional = the baton id
  const batonId = args.find((a, i) => {
    if (a.startsWith('--')) return false;
    if (promptIdx >= 0 && i === promptIdx + 1) return false;
    return true;
  });
  if (!batonId) {
    console.error('Usage: propose-for-session.mjs <baton-session-id> [--prompt <path>] [--keep-clone] [--dry-run]');
    process.exit(64);
  }
  if (!existsSync(promptPath)) {
    console.error(`prompt file not found: ${promptPath}`);
    process.exit(2);
  }

  const session = lookupSession(batonId);
  if (!session) {
    console.error(`baton session not found: ${batonId}`);
    process.exit(2);
  }
  if (session.backend_id !== 'claude-code') {
    console.error(`backend is "${session.backend_id}", not claude-code — clone only supports claude sessions`);
    process.exit(2);
  }
  if (!session.claude_session_id) {
    console.error('no claude_session_id captured for this session');
    process.exit(2);
  }

  const srcJsonl = join(
    CLAUDE_PROJECTS_DIR,
    sanitizeCwd(session.worktree_path),
    `${session.claude_session_id}.jsonl`,
  );
  if (!existsSync(srcJsonl)) {
    console.error(`source JSONL missing: ${srcJsonl}`);
    process.exit(2);
  }

  const { newUuid, dstPath } = cloneJsonl(srcJsonl, session.worktree_path);
  console.error(`[clone] ${dstPath}`);

  if (dryRun) {
    console.error(`[dry-run] would: cd ${session.worktree_path}; claude --resume ${newUuid} -p "<maestro prompt>"`);
    if (!keepClone) unlinkSync(dstPath);
    process.exit(0);
  }

  const promptText = readFileSync(promptPath, 'utf8');
  let proposal;
  try {
    const raw = runClaude({
      cloneUuid: newUuid,
      worktreePath: session.worktree_path,
      promptText,
    });
    proposal = extractProposal(raw);
  } finally {
    if (!keepClone) {
      try { unlinkSync(dstPath); } catch { /* best-effort */ }
    }
  }

  const out = {
    baton_session_id: session.id,
    target_project_id: session.project_id,
    worktree_path: session.worktree_path,
    branch: session.branch,
    claude_session_id: session.claude_session_id,
    clone_session_id: newUuid,
    proposal,
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
