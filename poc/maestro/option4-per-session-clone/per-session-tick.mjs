#!/usr/bin/env node
// poc/maestro/option4-per-session-clone/per-session-tick.mjs
//
// One Maestro tick using the per-session-clone architecture (option 4).
//
// Architecture:
//   1. Read baton DB + projects.
//   2. Apply the F15.1 runtime gate to get the candidate set:
//      drop running claude/codex (user-active), shells, snoozed,
//      and the master-mind itself (session_kind = 'maestro').
//   3. For each candidate, in parallel (capped concurrency), invoke
//      propose-for-session.mjs (clones the JSONL, runs claude --print
//      with the Maestro reflection prompt, parses JSON proposal).
//   4. Aggregate the proposals into a last-plan.json matching the
//      same shape option3's master-session writes.
//
// Output:
//   poc/maestro/option4-per-session-clone/last-plan.json
//   poc/maestro/option4-per-session-clone/state/plans/tick-NNNN.json
//
// State (cross-tick counter only — no continuous claude session here):
//   poc/maestro/option4-per-session-clone/state/tick-count

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

const HERE = dirname(import.meta.url.replace('file://', ''));
const BATON_DIR = process.env.BATON_DIR ?? join(homedir(), '.baton');
const DB_PATH = join(BATON_DIR, 'baton.db');
const STATE_DIR = join(HERE, 'state');
const PLANS_DIR = join(STATE_DIR, 'plans');
const TICK_COUNT_FILE = join(STATE_DIR, 'tick-count');
const LAST_PLAN_PATH = join(HERE, 'last-plan.json');
const PROPOSE_SCRIPT = join(HERE, 'propose-for-session.mjs');

const CONCURRENCY = Number.parseInt(process.env.MAESTRO_OPT4_CONCURRENCY ?? '4', 10);
const PER_SESSION_TIMEOUT_MS = Number.parseInt(process.env.MAESTRO_OPT4_TIMEOUT_MS ?? '240000', 10);

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
  };
}

function readTickCount() {
  try {
    const s = readFileSync(TICK_COUNT_FILE, 'utf8').trim();
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeTickCount(n) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(TICK_COUNT_FILE, String(n));
}

/** F15.1 runtime gate (mirrors the SKILL.md spec used by option3). */
function filterCandidates(sessions, projectsById) {
  return sessions.filter((s) => {
    const project = projectsById.get(s.project_id);
    const projectSnoozed = project?.snoozed_at != null;
    if (s.snoozed_at != null || projectSnoozed) return false;
    // Drop the master-mind itself
    if (s.session_kind === 'maestro') return false;
    // Drop shells — never resume/initiate targets
    if (s.backend_id === 'shell') return false;
    // Drop running claude/codex — user is at the keyboard
    if ((s.backend_id === 'claude-code' || s.backend_id === 'codex') && s.status === 'running') {
      return false;
    }
    // Drop sessions without a claude_session_id (no JSONL to clone)
    if (s.backend_id === 'claude-code' && !s.claude_session_id) return false;
    return true;
  });
}

/** Run propose-for-session.mjs as a child process; return parsed JSON. */
async function proposeFor(batonId) {
  const { stdout } = await execFileAsync('node', [PROPOSE_SCRIPT, batonId], {
    timeout: PER_SESSION_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

/** Map a per-session proposal (the JSON the cloned agent returned)
 *  into the action shape option3's last-plan.json uses, so the same
 *  baton UI can render either. */
function mapToAction(perSessionOutput) {
  const { proposal: p, baton_session_id, target_project_id } = perSessionOutput;
  const confidenceFromBucket = { high: 0.85, medium: 0.60, low: 0.35 };
  // resume → resume action (prompt is the user-voice next message).
  // wait / defer → defer (no prompt sent; rationale carries the why).
  const kind = p.action === 'resume' ? 'resume' : 'defer';
  return {
    action_id: randomUUID(),
    kind,
    target_session_id: baton_session_id,
    target_project_id,
    backlog_item: null,
    prompt: p.action === 'resume' ? (p.prompt ?? null) : null,
    rationale: p.rationale ?? null,
    confidence: confidenceFromBucket[p.confidence] ?? 0.5,
    assumptions_made: p.assumption
      ? [{
          question: p.assumption,
          assumed_answer: 'see proposal',
          if_wrong: p.if_wrong ?? null,
        }]
      : [],
    reversibility_note: p.reversibility_cost
      ? `${p.reversibility_cost} to revert${p.if_wrong ? `: ${p.if_wrong}` : ''}`
      : null,
  };
}

async function pmap(items, fn, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try { results[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (e) { results[i] = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`No baton.db at ${DB_PATH}`);
    process.exit(2);
  }

  const startedAt = new Date();
  const projects = sqliteJson(
    `SELECT id, name, path, snoozed_at FROM projects WHERE connection_id = 'local'`
  );
  const projectsById = new Map(projects.map((p) => [p.id, p]));

  const sessions = sqliteJson(
    `SELECT id, project_id, backend_id, branch, worktree_path, status,
            tokens_in, tokens_out, last_summary, started_at, snoozed_at,
            claude_session_id, session_kind
       FROM sessions WHERE ended_at IS NULL`
  );
  const candidates = filterCandidates(sessions, projectsById);

  console.error(`[tick] candidates: ${candidates.length} of ${sessions.length}`);
  for (const c of candidates) {
    const p = projectsById.get(c.project_id);
    console.error(`  · ${c.id.slice(0,8)}  ${p?.name ?? '<unknown>'}/${c.branch}  (${c.status})`);
  }

  const results = await pmap(
    candidates,
    async (c) => proposeFor(c.id),
    CONCURRENCY,
  );

  const usage = readUsage();
  const actions = [];
  const errors = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const r = results[i];
    if (r.ok) {
      actions.push(mapToAction(r.value));
    } else {
      errors.push({ baton_session_id: c.id, error: r.error });
      console.error(`[fail] ${c.id.slice(0,8)}: ${r.error.split('\n')[0]}`);
    }
  }

  const tickCount = readTickCount() + 1;
  const plan = {
    tick_at: startedAt.toISOString(),
    skip_reason: candidates.length === 0 ? 'no_candidates' : null,
    reasoning:
      `Option 4 (per-session clone). Asked each of ${candidates.length} candidate sessions ` +
      `for its own next-action proposal in parallel (concurrency=${CONCURRENCY}). ` +
      `${errors.length > 0 ? `${errors.length} session(s) failed to propose; see errors.` : 'All proposals returned.'}`,
    usage_pct_5h: usage.usage_pct_5h,
    usage_pct_7d: usage.usage_pct_7d,
    actions,
    errors,
  };

  writeFileSync(LAST_PLAN_PATH, JSON.stringify(plan, null, 2));
  mkdirSync(PLANS_DIR, { recursive: true });
  writeFileSync(
    join(PLANS_DIR, `tick-${String(tickCount).padStart(4, '0')}.json`),
    JSON.stringify(plan, null, 2),
  );
  writeTickCount(tickCount);

  console.error(`[tick] ${actions.length} action(s), ${errors.length} error(s) → ${LAST_PLAN_PATH}`);
  console.log(JSON.stringify({ tick: tickCount, actions: actions.length, errors: errors.length }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
