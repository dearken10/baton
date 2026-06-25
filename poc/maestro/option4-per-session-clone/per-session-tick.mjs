#!/usr/bin/env node
// poc/maestro/option4-per-session-clone/per-session-tick.mjs
//
// One Maestro tick using the per-session-clone architecture (option 4).
//
// Three-phase fallback:
//
//   Phase 1 — what's your next user message?
//     For each candidate, clone JSONL → claude --print with
//     prompts/next-action.md. Proposals are resume/wait/defer.
//     If ANY resume comes back, that's the plan. Done.
//
//   Phase 2 — any outstanding work to pick up?
//     Only runs if phase 1 produced 0 resumes. Re-asks each non-resume
//     candidate the follow-up: "is there work you implicitly committed
//     to that you could pick up now without new user input?"
//     Same JSON shape. If ANY resume here, plan is set. Done.
//
//   Phase 3 — what should the user start fresh on?
//     Only runs if phase 2 ALSO produced 0 resumes. Reads project docs
//     (.baton/backlog.md, PRD.md, TODO.md, ROADMAP.md) and a single
//     claude --print call asks for one concrete piece to kick off as
//     a new agent session. Yields an `initiate` action or wait.
//
//   Output: last-plan.json with whatever phase produced actions, plus
//   a `phase` field on the plan noting which one fired.
//
// Output:
//   poc/maestro/option4-per-session-clone/last-plan.json
//   poc/maestro/option4-per-session-clone/state/plans/tick-NNNN.json
//
// State (cross-tick counter only — no continuous claude session here):
//   poc/maestro/option4-per-session-clone/state/tick-count

import { execFile, execFileSync, spawnSync } from 'node:child_process';
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
const PHASE1_PROMPT = join(HERE, 'prompts', 'next-action.md');
const PHASE2_PROMPT = join(HERE, 'prompts', 'outstanding-tasks.md');
const PHASE3_PROMPT = join(HERE, 'prompts', 'phase3-from-docs.md');

const CONCURRENCY = Number.parseInt(process.env.MAESTRO_OPT4_CONCURRENCY ?? '4', 10);
const PER_SESSION_TIMEOUT_MS = Number.parseInt(process.env.MAESTRO_OPT4_TIMEOUT_MS ?? '240000', 10);
const PHASE3_TIMEOUT_MS = Number.parseInt(process.env.MAESTRO_OPT4_PHASE3_TIMEOUT_MS ?? '180000', 10);
/** Files we'll read from each project root to feed phase 3. Anything
 *  the user maintains as their "what should come next" list belongs
 *  here. Caps are applied per file so a 100KB PRD doesn't dominate. */
const PHASE3_DOC_FILES = [
  '.baton/backlog.md',
  'TODO.md',
  'ROADMAP.md',
  'PRD.md',
  'README.md',
];
const PHASE3_DOC_CAP_BYTES = 16 * 1024;
const PHASE3_TOTAL_DOC_CAP_BYTES = 120 * 1024;

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
    // Per-project Maestro opt-out. Defaults true for projects whose
    // row pre-dates the column.
    if (project && (project.maestro_enabled ?? 1) === 0) return false;
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
async function proposeFor(batonId, promptPath) {
  const args = [PROPOSE_SCRIPT, batonId, '--prompt', promptPath];
  const { stdout } = await execFileAsync('node', args, {
    timeout: PER_SESSION_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

/** Run propose-for-session over an array of baton ids, in parallel,
 *  with the given prompt. Returns the results array (in input order)
 *  shaped { ok: true, value } | { ok: false, error }. */
async function proposeForBatch(batonIds, promptPath) {
  return pmap(
    batonIds,
    async (id) => proposeFor(id, promptPath),
    CONCURRENCY,
  );
}

/** Read up to PHASE3_DOC_CAP_BYTES of one file. Returns null when
 *  the file doesn't exist or can't be read. */
function readDocFile(absPath) {
  try {
    if (!existsSync(absPath)) return null;
    const sz = statSync(absPath).size;
    const buf = readFileSync(absPath, 'utf8');
    if (sz > PHASE3_DOC_CAP_BYTES) {
      return buf.slice(0, PHASE3_DOC_CAP_BYTES)
        + `\n\n…[truncated by Maestro at ${PHASE3_DOC_CAP_BYTES} bytes, full size ${sz}]`;
    }
    return buf;
  } catch {
    return null;
  }
}

/** Gather project docs for phase 3. Walks each project's root for the
 *  files in PHASE3_DOC_FILES and assembles a single Markdown blob.
 *  Hard caps the total at PHASE3_TOTAL_DOC_CAP_BYTES so big PRDs
 *  don't crowd out other projects. */
function gatherPhase3Docs(projects) {
  const sections = [];
  let totalBytes = 0;
  for (const p of projects) {
    if (!p.path || !p.path.startsWith('/')) continue;
    // Skip Maestro-disabled or snoozed projects — we shouldn't
    // suggest initiating a worktree on something the user opted out
    // of orchestrating.
    if ((p.maestro_enabled ?? 1) === 0) continue;
    if (p.snoozed_at != null) continue;
    const docs = [];
    for (const rel of PHASE3_DOC_FILES) {
      const abs = join(p.path, rel);
      const body = readDocFile(abs);
      if (!body || body.trim().length === 0) continue;
      docs.push(`### ${rel}\n\n${body}`);
    }
    if (docs.length === 0) continue;
    const section =
      `## Project: ${p.name} (id=${p.id})\n` +
      `Path: ${p.path}\n\n` +
      docs.join('\n\n');
    if (totalBytes + section.length > PHASE3_TOTAL_DOC_CAP_BYTES) {
      sections.push(
        `\n…[Maestro stopped collecting docs at ${totalBytes} bytes; ${projects.length} projects total]`,
      );
      break;
    }
    sections.push(section);
    totalBytes += section.length;
  }
  return sections.join('\n\n---\n\n');
}

/** Phase 3: a single claude --print call over the project docs blob.
 *  No clone, no resume — fresh model context with the phase 3 prompt
 *  as the user message and the docs concatenated below. Returns the
 *  parsed proposal or null when nothing usable came back. */
function runPhase3(projects) {
  const docs = gatherPhase3Docs(projects);
  if (!docs || docs.trim().length === 0) {
    console.error('[phase3] no project docs found');
    return null;
  }
  const promptText =
    readFileSync(PHASE3_PROMPT, 'utf8') +
    `\n\n---\n\n# Project docs\n\n${docs}`;

  // Run claude in an arbitrary cwd — there's no session to resume,
  // and the model isn't asked to use tools. The HOME cwd is fine.
  const res = spawnSync(
    'claude',
    ['-p', promptText, '--dangerously-skip-permissions'],
    {
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: PHASE3_TIMEOUT_MS,
    },
  );
  if (res.error) { console.error('[phase3] spawn error:', res.error.message); return null; }
  if (res.status !== 0) {
    console.error(`[phase3] claude exited ${res.status}\n${(res.stderr ?? '').trim()}`);
    return null;
  }

  let s = (res.stdout ?? '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) {
    console.error('[phase3] no JSON in response');
    return null;
  }
  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch (e) {
    console.error('[phase3] JSON parse failed:', e.message);
    return null;
  }
}

/** Map a phase 3 proposal to the option3 action shape. */
function mapPhase3ToAction(p) {
  const confidenceFromBucket = { high: 0.85, medium: 0.60, low: 0.35 };
  return {
    action_id: randomUUID(),
    kind: p.action === 'initiate' ? 'initiate' : 'defer',
    target_session_id: null,
    target_project_id: p.project_id || null,
    target_branch: p.action === 'initiate' ? (p.branch || null) : null,
    backlog_item: p.source || null,
    prompt: p.action === 'initiate' ? (p.prompt ?? null) : null,
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
    `SELECT id, name, path, snoozed_at, maestro_enabled FROM projects WHERE connection_id = 'local'`
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

  const usage = readUsage();
  const errors = [];
  const actions = [];

  // ── Phase 1 ──────────────────────────────────────────────────────
  console.error(`[phase1] asking ${candidates.length} candidate(s) for next-action`);
  const p1Results = await proposeForBatch(candidates.map((c) => c.id), PHASE1_PROMPT);
  const p1Actions = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const r = p1Results[i];
    if (!r.ok) {
      errors.push({ phase: 1, baton_session_id: c.id, error: r.error });
      console.error(`[phase1.fail] ${c.id.slice(0,8)}: ${r.error.split('\n')[0]}`);
      continue;
    }
    p1Actions.push({ candidate: c, value: r.value, action: mapToAction(r.value) });
  }
  const p1Resumes = p1Actions.filter((a) => a.action.kind === 'resume');

  let firedPhase = 1;
  let phase3Action = null;

  if (p1Resumes.length > 0) {
    // Phase 1 found work — ship it.
    for (const a of p1Actions) actions.push(a.action);
  } else {
    // ── Phase 2 ────────────────────────────────────────────────────
    // Re-poll just the candidates that returned non-resume. (If they
    // failed in phase 1 they don't get a second chance — the error
    // already tells us something's broken with that session.)
    const phase2Targets = p1Actions
      .filter((a) => a.action.kind !== 'resume')
      .map((a) => a.candidate);
    console.error(
      `[phase2] phase1 found no resumes; re-asking ${phase2Targets.length} candidate(s) ` +
      'for outstanding work'
    );
    const p2Results = await proposeForBatch(
      phase2Targets.map((c) => c.id),
      PHASE2_PROMPT,
    );
    const p2Actions = [];
    for (let i = 0; i < phase2Targets.length; i++) {
      const c = phase2Targets[i];
      const r = p2Results[i];
      if (!r.ok) {
        errors.push({ phase: 2, baton_session_id: c.id, error: r.error });
        console.error(`[phase2.fail] ${c.id.slice(0,8)}: ${r.error.split('\n')[0]}`);
        continue;
      }
      p2Actions.push({ candidate: c, value: r.value, action: mapToAction(r.value) });
    }
    const p2Resumes = p2Actions.filter((a) => a.action.kind === 'resume');

    if (p2Resumes.length > 0) {
      firedPhase = 2;
      // Prefer the phase-2 result for each session; everything else from phase 1.
      const overridden = new Set(p2Actions.map((a) => a.candidate.id));
      for (const a of p1Actions) {
        if (!overridden.has(a.candidate.id)) actions.push(a.action);
      }
      for (const a of p2Actions) actions.push(a.action);
    } else {
      // ── Phase 3 ──────────────────────────────────────────────────
      console.error('[phase3] phase2 also empty; scanning project docs');
      const p3 = runPhase3(projects);
      if (p3 && p3.action === 'initiate' && p3.project_id) {
        firedPhase = 3;
        phase3Action = mapPhase3ToAction(p3);
        actions.push(phase3Action);
        // Keep phase 1's defers too so the UI still shows session state.
        for (const a of p1Actions) actions.push(a.action);
      } else {
        // Nothing actionable anywhere — surface phase 1's defers and call it.
        for (const a of p1Actions) actions.push(a.action);
      }
    }
  }

  const tickCount = readTickCount() + 1;
  const plan = {
    tick_at: startedAt.toISOString(),
    skip_reason: candidates.length === 0 ? 'no_candidates' : null,
    fired_phase: firedPhase,
    reasoning:
      `Option 4 (per-session clone), phase ${firedPhase} fired. ` +
      `Phase 1 polled ${candidates.length} candidate(s); ` +
      `${p1Resumes.length} resume(s). ` +
      (firedPhase >= 2 ? 'Phase 2 re-asked the non-resume set for outstanding work; ' : '') +
      (firedPhase === 3 ? 'Phase 3 scanned project docs for an initiate suggestion.' : '') +
      (errors.length > 0 ? ` ${errors.length} per-session failure(s); see errors.` : ''),
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

  console.error(`[tick] phase ${firedPhase} · ${actions.length} action(s), ${errors.length} error(s) → ${LAST_PLAN_PATH}`);
  console.log(JSON.stringify({
    tick: tickCount,
    fired_phase: firedPhase,
    actions: actions.length,
    errors: errors.length,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
