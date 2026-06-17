/**
 * Maestro session reader — parses the master Claude Code session's
 * JSONL transcript at ~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl,
 * segments it by `/maestro-tick` boundaries, normalizes each turn into
 * the renderer-friendly Block union, and correlates successful
 * boundaries against `poc/maestro/option3-master-session/state/plans/
 * tick-NNNN.json` so the Session view can show each tick's actions
 * alongside its conversation.
 *
 * Why "session" and not "transcript"? Because the renderer cares about
 * the *whole picture* — ticks, turns, AND plan outputs — and stitching
 * those together is the point of this file.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';

import type { ResponseOf } from '../../shared/ipc.js';

type SessionResponse = ResponseOf<'maestro.getSession'>;
type Tick = SessionResponse['ticks'][number];
type Turn = Tick['turns'][number];
type Block = Turn['blocks'][number];
type Plan = NonNullable<Tick['plan']>;

const TOOL_RESULT_PREVIEW_BYTES = 1_024;
const TOOL_INPUT_PREVIEW_CHARS = 200;
const DEFAULT_TICK_LIMIT = 50;

function maestroStateDir(): string {
  const appPath = app.getAppPath();
  const repoRoot = join(appPath, '..');
  return join(repoRoot, 'poc', 'maestro', 'option3-master-session', 'state');
}

function masterRepoRoot(): string {
  return join(maestroStateDir(), '..', '..', '..', '..');
}

/** Sanitize a cwd to the directory name Claude Code uses under
 *  `~/.claude/projects/`. Matches the CLI's normalization: replace
 *  `/`, `.`, `_` with `-`. */
function sanitizeCwdForClaude(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}

function transcriptPath(sessionId: string): string {
  return join(
    homedir(),
    '.claude',
    'projects',
    sanitizeCwdForClaude(masterRepoRoot()),
    `${sessionId}.jsonl`,
  );
}

function readSessionId(): string | null {
  const p = join(maestroStateDir(), 'session-id');
  if (!existsSync(p)) return null;
  try {
    const s = readFileSync(p, 'utf8').trim();
    return s || null;
  } catch { return null; }
}

/** Match Claude Code's `<command-name>/maestro-tick</command-name>`
 *  wrapper. The `<command-message>` line precedes it; the surrounding
 *  text may carry args, but for our skill it's always exactly this. */
function isTickSlashCommand(s: string): boolean {
  return /<command-name>\/maestro-tick<\/command-name>/.test(s);
}

function isSkillBootstrap(s: string): boolean {
  return s.startsWith('Base directory for this skill:');
}

function extractText(block: unknown): string | null {
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object') {
    const b = block as Record<string, unknown>;
    if (typeof b.text === 'string') return b.text;
  }
  return null;
}

function previewToolInput(input: unknown): string {
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > TOOL_INPUT_PREVIEW_CHARS
    ? s.slice(0, TOOL_INPUT_PREVIEW_CHARS) + '…'
    : s;
}

function previewToolResult(content: unknown): { preview: string; isError: boolean } {
  let isError = false;
  let raw: string;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text;
        }
        return '';
      })
      .join('\n');
  } else if (content && typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (typeof o.text === 'string') raw = o.text;
    else raw = JSON.stringify(content);
    if (o.is_error === true) isError = true;
  } else {
    raw = String(content);
  }
  if (raw.length > TOOL_RESULT_PREVIEW_BYTES) {
    raw = raw.slice(0, TOOL_RESULT_PREVIEW_BYTES) + `\n… [truncated, ${raw.length} total bytes]`;
  }
  return { preview: raw, isError };
}

function normalizeAssistantBlocks(content: unknown): Block[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
      out.push({ kind: 'text', text: b.text });
    } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0) {
      out.push({ kind: 'thinking', text: b.thinking });
    } else if (b.type === 'tool_use' && typeof b.name === 'string') {
      out.push({
        kind: 'tool_use',
        name: b.name,
        inputPreview: previewToolInput(b.input),
      });
    }
  }
  return out;
}

function normalizeUserBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      out.push({ kind: 'text', text: block });
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push({ kind: 'text', text: b.text });
    } else if (b.type === 'tool_result') {
      const { preview, isError } = previewToolResult(b.content);
      out.push({ kind: 'tool_result', preview, isError });
    }
  }
  return out;
}

/** Load all plan files from state/plans, return them keyed by the
 *  tick number embedded in their filename (`tick-0027.json` → 27). */
function loadPlans(): Map<number, Plan> {
  const dir = join(maestroStateDir(), 'plans');
  const out = new Map<number, Plan>();
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch { return out; }
  for (const name of entries) {
    const m = /^tick-(\d{4})\.json$/.exec(name);
    if (!m) continue;
    const tickNum = Number.parseInt(m[1]!, 10);
    if (!Number.isFinite(tickNum)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        tick_at: string;
        skip_reason: string | null;
        reasoning: string;
        actions: Array<{
          action_id: string;
          kind: 'resume' | 'initiate' | 'defer';
          target_session_id: string | null;
          target_project_id: string | null;
          prompt: string | null;
          rationale: string;
          confidence: number;
          assumptions_made?: Array<{
            question: string;
            assumed_answer: string;
            why?: string;
            if_wrong?: string;
          }>;
          reversibility_note?: string;
        }>;
      };
      out.set(tickNum, {
        tickAt:     raw.tick_at,
        skipReason: raw.skip_reason,
        reasoning:  raw.reasoning,
        actions: raw.actions.map((a) => ({
          actionId:        a.action_id,
          kind:            a.kind,
          targetSessionId: a.target_session_id,
          targetProjectId: a.target_project_id,
          prompt:          a.prompt,
          rationale:       a.rationale,
          confidence:      a.confidence,
          assumptionsMade: (a.assumptions_made ?? []).map((x) => ({
            question:      x.question,
            assumedAnswer: x.assumed_answer,
            why:           x.why,
            ifWrong:       x.if_wrong,
          })),
          reversibilityNote: a.reversibility_note,
        })),
      });
    } catch {
      // Malformed plan; skip silently — view degrades to "plan unavailable".
    }
  }
  return out;
}

/** Walk the JSONL and emit one segment per `/maestro-tick` boundary.
 *  The segment includes everything from the slash-command turn up to
 *  (but not including) the next slash command. Non-message records
 *  (queue-operation / attachment / ai-title / last-prompt) are skipped
 *  silently — the view doesn't need them. */
function segmentTranscript(raw: string): Tick[] {
  const ticks: Tick[] = [];
  let current: Tick | null = null;
  const lines = raw.split('\n');

  const finishCurrent = (): void => {
    if (!current) return;
    current.turnCount = current.turns.length;
    if (current.turns.length > 0) {
      const last = current.turns[current.turns.length - 1]!;
      current.endedAt = last.timestamp ?? current.endedAt;
    }
    ticks.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.length) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch { continue; }

    const type = rec.type;
    if (type !== 'user' && type !== 'assistant') continue;

    const message = rec.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const contentRaw = message.content;
    const uuid = typeof rec.uuid === 'string' ? rec.uuid : `i-${i}`;
    const timestamp = typeof rec.timestamp === 'string' ? rec.timestamp : null;

    if (type === 'user') {
      // Look at the first text block to detect a tick boundary.
      let firstText: string | null = null;
      if (typeof contentRaw === 'string') firstText = contentRaw;
      else if (Array.isArray(contentRaw)) {
        for (const b of contentRaw) {
          const t = extractText(b);
          if (t !== null) { firstText = t; break; }
        }
      }
      const isTickStart = firstText !== null && isTickSlashCommand(firstText);

      if (isTickStart) {
        // Close out the previous tick segment, start a new one.
        finishCurrent();
        current = {
          index:     ticks.length + 1,
          startedAt: timestamp ?? new Date().toISOString(),
          endedAt:   null,
          status:    'in-progress',
          statusDetail: null,
          turnCount: 0,
          turns: [],
          plan:  null,
        };
        // Render the boundary as a single clean turn — drop the noisy
        // <command-message> XML wrapper.
        current.turns.push({
          id: uuid,
          role: 'user',
          timestamp,
          blocks: [{ kind: 'text', text: '/maestro-tick' }],
          isTickStart: true,
        });
        continue;
      }

      // Inside a tick: drop the skill-bootstrap blob (Claude injects
      // the SKILL.md as a follow-up user message; the user never typed
      // it). If that leaves nothing, drop the whole turn.
      let blocks = normalizeUserBlocks(contentRaw);
      blocks = blocks.filter((b) => !(b.kind === 'text' && isSkillBootstrap(b.text)));
      if (blocks.length === 0) continue;

      // If we haven't seen a tick boundary yet, this is bootstrap
      // chatter — bucket it under a synthetic "tick 0" so it shows up
      // somewhere instead of vanishing.
      if (!current) {
        current = {
          index:     0,
          startedAt: timestamp ?? new Date().toISOString(),
          endedAt:   null,
          status:    'in-progress',
          statusDetail: null,
          turnCount: 0,
          turns: [],
          plan:  null,
        };
      }
      current.turns.push({
        id: uuid,
        role: 'user',
        timestamp,
        blocks,
        isTickStart: false,
      });
      continue;
    }

    // assistant
    const blocks = normalizeAssistantBlocks(contentRaw);
    if (blocks.length === 0) continue;
    if (!current) {
      current = {
        index:     0,
        startedAt: timestamp ?? new Date().toISOString(),
        endedAt:   null,
        status:    'in-progress',
        statusDetail: null,
        turnCount: 0,
        turns: [],
        plan:  null,
      };
    }
    current.turns.push({
      id: uuid,
      role: 'assistant',
      timestamp,
      blocks,
      isTickStart: false,
    });
  }
  finishCurrent();
  return ticks;
}

/** Assign plan JSON to JSONL ticks by timestamp window.
 *
 *  Each plan carries a `tick_at` written by the master at inventory
 *  time — usually a few seconds into the boundary's segment. We match
 *  by checking which boundary's window `tick_at` falls into:
 *  plan.tickAt ∈ [tick.startedAt, nextTick.startedAt).
 *
 *  Why not count successful boundaries and map K→plan-{K}? That was
 *  the previous heuristic and it drifts: scanning assistant text for
 *  failure markers misfires when a successful tick *mentions* an
 *  error from another agent (saw this with "API Error: Stream idle
 *  timeout" being discussed in tick 27's summary), pushing every
 *  later tick's plan pointer back. Timestamps don't lie.
 *
 *  Both lists are pre-sorted (JSONL is chronological by construction;
 *  we sort plans here), so the walk is linear. */
function correlatePlans(ticks: Tick[], plans: Map<number, Plan>): void {
  const sortedPlans = [...plans.values()].sort(
    (a, b) => Date.parse(a.tickAt) - Date.parse(b.tickAt)
  );
  let pi = 0;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    const startMs = Date.parse(t.startedAt);
    const nextStartMs = i + 1 < ticks.length
      ? Date.parse(ticks[i + 1]!.startedAt)
      : Number.POSITIVE_INFINITY;
    // Advance past any plans that closed before this tick started —
    // shouldn't happen on a clean transcript, but guards against state
    // dir holding stale plans from a prior session-id.
    while (pi < sortedPlans.length
           && Date.parse(sortedPlans[pi]!.tickAt) < startMs) {
      pi += 1;
    }
    if (pi >= sortedPlans.length) break;
    const planMs = Date.parse(sortedPlans[pi]!.tickAt);
    if (planMs >= startMs && planMs < nextStartMs) {
      t.plan = sortedPlans[pi]!;
      pi += 1;
    }
  }
}

/** Classify each tick after correlation: presence of a matching plan
 *  is the definitive success signal, since the plan is only written
 *  by a tick that finished its work. No plan → look at assistant text
 *  to distinguish auth failures from "still in progress" (latest
 *  tick) from generic "ran but didn't write" cases. */
function classifyTick(tick: Tick): void {
  if (tick.plan) {
    tick.status = 'success';
    return;
  }

  let hasAssistant = false;
  let failureDetail: string | null = null;
  for (const turn of tick.turns) {
    if (turn.role !== 'assistant') continue;
    hasAssistant = true;
    for (const b of turn.blocks) {
      if (b.kind !== 'text') continue;
      // Match strict "Failed to authenticate" only — the daemon's
      // own error message — not the substring "API Error" which
      // appears in summaries about other agents' errors.
      if (/Failed to authenticate/i.test(b.text)) {
        const m = /(API Error:\s*\d{3})/.exec(b.text);
        failureDetail = m ? `auth · ${m[1]}` : 'auth failed';
      }
    }
  }

  if (!hasAssistant) {
    tick.status = 'in-progress';
  } else {
    tick.status = 'failed';
    tick.statusDetail = failureDetail ?? 'no plan written';
  }
}

export function getMaestroSession(tickLimit?: number): SessionResponse {
  const sessionId = readSessionId();
  if (!sessionId) {
    return {
      available: false,
      sessionId: null,
      transcriptPath: null,
      ticks: [],
      totalTicks: 0,
    };
  }
  const path = transcriptPath(sessionId);
  if (!existsSync(path)) {
    return {
      available: false,
      sessionId,
      transcriptPath: path,
      ticks: [],
      totalTicks: 0,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {
      available: true,
      sessionId,
      transcriptPath: path,
      ticks: [],
      totalTicks: 0,
    };
  }

  const allTicks = segmentTranscript(raw);
  const plans = loadPlans();
  correlatePlans(allTicks, plans);
  for (const t of allTicks) classifyTick(t);

  const totalTicks = allTicks.length;
  const limit = tickLimit ?? DEFAULT_TICK_LIMIT;
  const ticks = totalTicks > limit ? allTicks.slice(totalTicks - limit) : allTicks;

  return {
    available: true,
    sessionId,
    transcriptPath: path,
    ticks,
    totalTicks,
  };
}
