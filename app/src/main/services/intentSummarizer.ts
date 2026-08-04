/**
 * Summarise what a Claude Code session is doing in ~4 words so the
 * left-column chip can read "Refactoring auth middleware" instead of
 * the opaque "wip-4cca65" (PRD F4).
 *
 * Implementation:
 *   - On every Stop hook, we look at the most recent user prompt in
 *     the session's transcript and shell out to `claude -p --model
 *     haiku` to get a tight summary. The Claude Code CLI auth is the
 *     user's own, so we don't need a separate API key.
 *   - The call is fire-and-forget from the agent's POV: we never
 *     block the Stop hook.
 *   - Per-session throttle: at most one summary every 90 seconds, so
 *     bursty Stop hooks don't burn Haiku tokens.
 *   - We cap the prompt at the last user message + a small slice of
 *     the most recent assistant reply, so the summariser has just
 *     enough context without paying for the whole conversation.
 */

import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { trace, shortSid } from './statusTrace.js';
import { readRecentCodexTurn } from './codexTranscriptReader.js';

const execFileP = promisify(execFile);

const THROTTLE_MS = 1_000;
/** Hard timeout — never let a stuck Haiku call leak processes. */
const TIMEOUT_MS = 20_000;
/** How many characters of the most recent user / assistant content
 *  to feed the summariser. Keeps token spend predictable. */
const CONTEXT_CHARS = 1200;
const MODEL = 'claude-haiku-4-5';

const lastRunBySession = new Map<string, number>();

interface JsonlLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/** Best-effort: extract a string from a Claude message.content. The
 *  content can be a string, an array of content blocks, or an array of
 *  text blocks with `{type:'text', text}`. We coerce to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in (c as object)) {
          const t = (c as { text?: unknown }).text;
          return typeof t === 'string' ? t : '';
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

/** Walk the transcript and return { lastUser, lastAssistant } slices. */
function readRecentTurn(transcriptPath: string): {
  lastUser: string;
  lastAssistant: string;
} | null {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch { return null; }
  const lines = raw.split('\n');
  let lastUser = '';
  let lastAssistant = '';
  for (let i = lines.length - 1; i >= 0 && (!lastUser || !lastAssistant); i--) {
    const line = lines[i];
    if (!line) continue;
    let obj: JsonlLine;
    try { obj = JSON.parse(line) as JsonlLine; } catch { continue; }
    const role = obj.message?.role ?? obj.type;
    const text = contentToText(obj.message?.content);
    if (!text) continue;
    if (!lastAssistant && role === 'assistant') lastAssistant = text;
    else if (!lastUser && (role === 'user' || obj.type === 'user')) lastUser = text;
  }
  if (!lastUser && !lastAssistant) return null;
  return {
    lastUser: lastUser.slice(0, CONTEXT_CHARS),
    lastAssistant: lastAssistant.slice(0, CONTEXT_CHARS),
  };
}

/** Merge a login env override onto the parent process env for a spawned
 *  `claude` call. A '' value is buildLoginEnv's "unset" sentinel — delete
 *  the inherited var rather than pass an empty string (which some CLIs
 *  treat as "set but blank"). Returns undefined when there's nothing to
 *  override, so the caller inherits process.env as before. */
function mergeLoginEnv(
  overrides: Record<string, string> | undefined
): NodeJS.ProcessEnv | undefined {
  if (!overrides || Object.keys(overrides).length === 0) return undefined;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === '') delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Run Haiku via the Claude CLI. Returns the trimmed summary string,
 *  or null on any error. `loginEnv` (from buildLoginEnv) points the call
 *  at the session's own login so an isolated/browser/token login is used
 *  instead of the machine's global CLI auth. */
async function callHaiku(
  sessionId: string,
  prompt: string,
  loginEnv?: Record<string, string>,
): Promise<string | null> {
  const t0 = Date.now();
  trace('SUMM_HAIKU_START', { sid: shortSid(sessionId), promptLen: prompt.length });
  try {
    const env = mergeLoginEnv(loginEnv);
    const { stdout } = await execFileP(
      'claude',
      ['-p', '--model', MODEL, prompt],
      { timeout: TIMEOUT_MS, ...(env ? { env } : {}) }
    );
    const trimmed = stdout
      .trim()
      .split('\n')[0]    // first non-empty line — Haiku sometimes adds a flourish
      ?.trim()
      ?? '';
    // Strip surrounding quotes the model occasionally adds.
    const result = trimmed.replace(/^["'`]|["'`]$/g, '').slice(0, 60) || null;
    trace('SUMM_HAIKU_DONE', {
      sid: shortSid(sessionId),
      elapsedMs: Date.now() - t0,
      resultLen: result?.length ?? 0,
      preview: (result ?? '').slice(0, 40).replace(/\s+/g, '_') || '∅',
    });
    return result;
  } catch (err) {
    trace('SUMM_HAIKU_ERR', {
      sid: shortSid(sessionId),
      elapsedMs: Date.now() - t0,
      err: String(err).slice(0, 80).replace(/\s+/g, '_'),
    });
    return null;
  }
}

export interface SummarizeArgs {
  sessionId: string;
  transcriptPath: string;
  /** Which backend's transcript format the file is in. We dispatch to
   *  the right reader: Claude's is `~/.claude/projects/<slug>/<id>.jsonl`
   *  with `message.role` lines; Codex's is `~/.codex/sessions/…` with
   *  `response_item` lines. */
  backendId: 'claude-code' | 'codex';
  /** Skip the per-session throttle. Used by user-initiated triggers
   *  (UserPromptSubmit) where we want the chip to update the moment
   *  the user hits enter, not 90 s later. Doesn't update the throttle
   *  clock either, so a forced call doesn't suppress the next
   *  natural Stop-driven call. */
  force?: boolean;
  /** The session's current `last_summary` from the DB, if any. We feed
   *  this to Haiku so generic prompts ("continue", "next", "fix that
   *  too") still produce a meaningful chip — Haiku can keep the old
   *  summary as-is, refine it, or replace it when the user pivots. */
  previousSummary?: string | null;
  /** Env override (from buildLoginEnv) so the summariser's `claude` call
   *  authenticates with the session's own login rather than the global
   *  machine login. Empty/omitted → inherit the parent env. */
  loginEnv?: Record<string, string>;
}

/**
 * Run a single summarisation pass for one session. Returns the
 * summary string when fresh work was done, null when throttled / no
 * context / Haiku failed. Caller persists the result and emits
 * `session.summarized` on the bus.
 */
export async function summarizeSession(
  args: SummarizeArgs
): Promise<string | null> {
  const now = Date.now();
  const last = lastRunBySession.get(args.sessionId) ?? 0;
  trace('SUMM_CALL', {
    sid: shortSid(args.sessionId),
    force: !!args.force,
    sinceLastMs: last ? now - last : -1,
    transcriptPath: args.transcriptPath.slice(-60),
  });
  if (!args.force) {
    if (now - last < THROTTLE_MS) {
      trace('SUMM_THROTTLED', { sid: shortSid(args.sessionId), sinceLastMs: now - last });
      return null;
    }
    lastRunBySession.set(args.sessionId, now);
  }

  const turn = args.backendId === 'codex'
    ? readRecentCodexTurn(args.transcriptPath, CONTEXT_CHARS)
    : readRecentTurn(args.transcriptPath);
  if (!turn) {
    let exists = false;
    let size = -1;
    try { const st = fs.statSync(args.transcriptPath); exists = true; size = st.size; }
    catch { /* file missing */ }
    trace('SUMM_NO_TURN', {
      sid: shortSid(args.sessionId),
      transcriptExists: exists,
      transcriptBytes: size,
    });
    return null;
  }

  // We deliberately base the summary on the user's prompt only.
  // Earlier versions also fed the recent assistant output as context;
  // Haiku's instruction-following on "context, do not summarise this"
  // is unreliable for short user prompts ("continue", "ok", "go"),
  // and it would echo the assistant text verbatim as the summary —
  // e.g. "I don't have context about what task you were previously".
  // The chip is meant to surface the user's intent, so the user's
  // prompt is the right signal anyway.
  if (!turn.lastUser.trim()) {
    trace('SUMM_NO_USER', {
      sid: shortSid(args.sessionId),
      lastAssistantLen: turn.lastAssistant.length,
    });
    return null;
  }
  const prev = args.previousSummary?.trim();
  const prompt =
    'Summarise the user\'s current task in 3 to 5 words. ' +
    'Use an action verb + concise object (e.g. "Refactoring auth middleware"). ' +
    'Output ONLY the summary, no quotes, no preamble.\n\n' +
    (prev
      ? `PREVIOUS SUMMARY (still valid unless the user pivots): "${prev}"\n\n`
      : '') +
    `USER PROMPT:\n${turn.lastUser}\n\n` +
    (prev
      ? 'If the user is continuing the same task (e.g. "continue", "go ' +
        'on", "next"), keep the previous summary. Otherwise write a ' +
        'fresh one based on the user\'s new prompt.\n\n'
      : '') +
    'Summary:';

  return callHaiku(args.sessionId, prompt, args.loginEnv);
}

/** Strip ANSI escape sequences and other terminal control codes so
 *  Haiku gets clean text. Keeps newlines + tabs. */
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const C0_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

function stripAnsi(s: string): string {
  // CSI: ESC [ params final-byte. OSC: ESC ] payload terminator.
  // C0 controls except CR/LF/TAB.
  return s.replace(ANSI_CSI, '').replace(ANSI_OSC, '').replace(C0_CONTROLS, '');
}

export interface SummarizeTerminalArgs {
  sessionId: string;
  /** Recent pty output bytes — the buffer SessionManager already keeps
   *  for late-mount replay. We sniff the tail of this for context. */
  recentBytes: Buffer;
  force?: boolean;
  /** The session's current `last_summary` from the DB, if any. */
  previousSummary?: string | null;
  /** Env override (from buildLoginEnv) so the summariser's `claude` call
   *  authenticates with the session's own login. */
  loginEnv?: Record<string, string>;
}

/** Same shape as summarizeSession but pulls context from a terminal's
 *  recent output rather than a Claude transcript. Used for shell
 *  (non-Claude) sessions so the chip can read "Running tests" or
 *  "Editing nginx.conf" instead of "❯ zsh". */
export async function summarizeTerminal(
  args: SummarizeTerminalArgs
): Promise<string | null> {
  const now = Date.now();
  if (!args.force) {
    const last = lastRunBySession.get(args.sessionId) ?? 0;
    if (now - last < THROTTLE_MS) return null;
    lastRunBySession.set(args.sessionId, now);
  }

  // Last 2x CONTEXT_CHARS of ANSI-stripped output. Two windows because
  // the prompt + a couple of commands fit comfortably; more than that
  // is noise for a 3-5 word summary.
  const text = stripAnsi(args.recentBytes.toString('utf-8'))
    .slice(-CONTEXT_CHARS * 2)
    .trim();
  if (!text) {
    trace('SUMM_TERM_NO_TEXT', { sid: shortSid(args.sessionId) });
    return null;
  }

  const prev = args.previousSummary?.trim();
  const prompt =
    'Summarise what the user is doing in this terminal in 3 to 5 words. ' +
    'Focus on the most recent command(s). Use an action verb + concise ' +
    'object (e.g. "Running tests", "Editing nginx config"). Output ' +
    'ONLY the summary, no quotes, no preamble.\n\n' +
    (prev
      ? `PREVIOUS SUMMARY (keep if the user is still on the same task): "${prev}"\n\n`
      : '') +
    'RECENT TERMINAL OUTPUT:\n' +
    text +
    '\n\nSummary:';

  return callHaiku(args.sessionId, prompt, args.loginEnv);
}
