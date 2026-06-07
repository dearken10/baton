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

const execFileP = promisify(execFile);

const THROTTLE_MS = 90_000;
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

/** Run Haiku via the Claude CLI. Returns the trimmed summary string,
 *  or null on any error. */
async function callHaiku(prompt: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'claude',
      ['-p', '--model', MODEL, prompt],
      { timeout: TIMEOUT_MS }
    );
    const trimmed = stdout
      .trim()
      .split('\n')[0]    // first non-empty line — Haiku sometimes adds a flourish
      ?.trim()
      ?? '';
    // Strip surrounding quotes the model occasionally adds.
    return trimmed.replace(/^["'`]|["'`]$/g, '').slice(0, 60) || null;
  } catch {
    return null;
  }
}

export interface SummarizeArgs {
  sessionId: string;
  transcriptPath: string;
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
  if (now - last < THROTTLE_MS) return null;
  lastRunBySession.set(args.sessionId, now);

  const turn = readRecentTurn(args.transcriptPath);
  if (!turn) return null;

  const prompt =
    'Summarise the user\'s current task to Claude Code in 3 to 5 words. ' +
    'Use an action verb + concise object (e.g. "Refactoring auth middleware"). ' +
    'Output ONLY the summary, no quotes, no preamble.\n\n' +
    `USER PROMPT:\n${turn.lastUser}\n\n` +
    `RECENT ASSISTANT OUTPUT (for context, do not summarise this):\n${turn.lastAssistant}\n\n` +
    'Summary:';

  return callHaiku(prompt);
}
