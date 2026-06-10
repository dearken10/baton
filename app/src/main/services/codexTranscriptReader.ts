/**
 * Read OpenAI Codex CLI's rollout transcripts.
 *
 * Layout: `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session_id>.jsonl`.
 * Each line is one of:
 *   - { type: 'session_meta',  payload: { id, cwd, … } }
 *   - { type: 'turn_context',  payload: { … } }
 *   - { type: 'event_msg',     payload: { … } }
 *   - { type: 'response_item', payload: { type: 'message', role: 'user'|'assistant'|'developer'|'system', content: [{type:'input_text', text}] } }
 *
 * We use this for:
 *   - finding a transcript by Codex session id (used by auto-resume and
 *     the chip's "can we resume?" check)
 *   - extracting the last user-typed prompt + last assistant text for
 *     the intent summariser
 *
 * Notes on "user" messages: Codex injects framing messages with the
 * same `role:"user"` shape — wrapped in <environment_context>,
 * <system_instruction>, <user_instructions>, etc. We treat any message
 * whose text starts with `<` (after trim) as framing and skip it; the
 * first naked user message walking backwards from EOF is the real
 * prompt.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Days to scan back for a Codex transcript before giving up. Two
 *  weeks is plenty for "resume the session I had yesterday" while
 *  keeping the scan cheap. */
const MAX_DAYS_BACK = 14;

interface ResponseItem {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: unknown;
  };
}

function codexSessionsRoot(): string {
  return process.env['CODEX_HOME']
    ? path.join(process.env['CODEX_HOME'] as string, 'sessions')
    : path.join(os.homedir(), '.codex', 'sessions');
}

/** Walk the YYYY/MM/DD tree for the last N days looking for a file
 *  whose name ends with `-<sessionId>.jsonl`. Returns the absolute
 *  path or null. */
export function findCodexTranscript(sessionId: string): string | null {
  if (!sessionId) return null;
  const root = codexSessionsRoot();
  const suffix = `-${sessionId}.jsonl`;
  const today = new Date();
  for (let i = 0; i < MAX_DAYS_BACK; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const dir = path.join(root, yyyy, mm, dd);
    let entries: string[];
    try { entries = fs.readdirSync(dir); }
    catch { continue; }
    for (const name of entries) {
      if (name.endsWith(suffix)) return path.join(dir, name);
    }
  }
  return null;
}

export function codexTranscriptExists(sessionId: string): boolean {
  return findCodexTranscript(sessionId) !== null;
}

/** Best-effort string extraction from a Codex response_item.payload.content
 *  array — joins all `input_text` chunks. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const c of content) {
    if (typeof c === 'string') { out.push(c); continue; }
    if (c && typeof c === 'object') {
      const obj = c as { type?: string; text?: unknown };
      // 'input_text' covers user-typed and dev-injected messages.
      // 'output_text' covers assistant text — same handling.
      if (
        (obj.type === 'input_text' || obj.type === 'output_text') &&
        typeof obj.text === 'string'
      ) {
        out.push(obj.text);
      }
    }
  }
  return out.join('\n');
}

/** True if the text is a Codex framing message wrapped in XML tags
 *  (environment_context, system_instruction, etc.) rather than a real
 *  user prompt. */
function looksLikeFraming(text: string): boolean {
  const trimmed = text.trim();
  // Real prompts can contain `<`, but they essentially never *start*
  // with one. Codex framing messages always start with a tag.
  return trimmed.startsWith('<') && /<\w+/.test(trimmed.slice(0, 80));
}

export interface CodexTurn {
  lastUser: string;
  lastAssistant: string;
}

/** Walk the transcript bottom-up and return the last real user prompt
 *  and last assistant text, each capped at `maxChars`. Either may be
 *  the empty string if nothing matched. Returns null only if the file
 *  is unreadable. */
export function readRecentCodexTurn(
  transcriptPath: string,
  maxChars = 1200,
): CodexTurn | null {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch { return null; }
  const lines = raw.split('\n');
  let lastUser = '';
  let lastAssistant = '';
  for (let i = lines.length - 1; i >= 0 && (!lastUser || !lastAssistant); i--) {
    const line = lines[i];
    if (!line) continue;
    let obj: ResponseItem;
    try { obj = JSON.parse(line) as ResponseItem; } catch { continue; }
    if (obj.type !== 'response_item') continue;
    if (obj.payload?.type !== 'message') continue;
    const text = contentToText(obj.payload.content);
    if (!text) continue;
    const role = obj.payload.role;
    if (!lastAssistant && role === 'assistant') {
      lastAssistant = text;
      continue;
    }
    if (!lastUser && role === 'user' && !looksLikeFraming(text)) {
      lastUser = text;
    }
  }
  return {
    lastUser: lastUser.slice(0, maxChars),
    lastAssistant: lastAssistant.slice(0, maxChars),
  };
}
