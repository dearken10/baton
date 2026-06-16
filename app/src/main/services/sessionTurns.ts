/**
 * Read a session's transcript and split it into structured "turns" for
 * the renderer's Turns view (the collapsible per-prompt card list that
 * lives alongside the live xterm pane).
 *
 * A turn is { userInput, progress[], recap }:
 *  - userInput   what the user typed (framing stripped, slash commands unwrapped)
 *  - progress[]  the assistant's working steps inside that turn — tool
 *                calls, tool results, and intermediate assistant text
 *  - recap       the LAST assistant text within the turn (the closing
 *                summary). null while the turn is still in flight.
 *
 * Source of truth is the agent's JSONL on disk; we don't try to track
 * this ourselves. Shell sessions have no transcript and return [].
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from '../../shared/ipc.js';
import { findCodexTranscript } from './codexTranscriptReader.js';

/** Mirror of sessionManager.claudeTranscriptPath — kept here so this
 *  module has no dependency on the (large) sessionManager. Same sanitise
 *  rule the rest of the codebase uses. */
function claudeTranscriptPath(cwd: string, claudeSessionId: string): string {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* fall back to cwd */ }
  const sanitized = real.replace(/[/._]/g, '-');
  return path.join(
    os.homedir(), '.claude', 'projects', sanitized, `${claudeSessionId}.jsonl`,
  );
}

export type ProgressItem =
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_use'; name: string; inputPreview: string }
  | { kind: 'tool_result'; ok: boolean; preview: string };

export interface SessionTurn {
  /** Stable per-turn id — used as the React key. Built from `ts` plus a
   *  hash of the first prompt chars so identical prompts at different
   *  times don't collide. */
  id: string;
  /** Wall-clock ms of the user prompt. 0 if the transcript carries none. */
  ts: number;
  userInput: string;
  progress: ProgressItem[];
  /** Final assistant text in the turn. null = no closing message yet
   *  (turn is still in flight, or ended on a tool call without a recap). */
  recap: string | null;
}

/** Hard cap — multi-day sessions can have thousands of turns; renderer
 *  shouldn't try to render them all at once. */
const MAX_TURNS = 200;

/** Claude wraps system-injected user messages in these tags; treat any
 *  such message as framing and skip. Slash commands (`<command-message>`
 *  / `<command-name>`) are NOT here — those are user-invoked. */
const CLAUDE_FRAMING_TAGS = new Set([
  'environment_context',
  'system_instruction',
  'user_instructions',
  'local-command-stdout',
  'system-reminder',
  'IMPORTANT-DO_NOT_DEVIATE',
]);

function isClaudeFraming(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('<')) return false;
  const match = t.match(/^<([\w-]+)/);
  if (!match) return false;
  return CLAUDE_FRAMING_TAGS.has(match[1] ?? '');
}

function unwrapSlashCommand(text: string): string {
  const name = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (name) return name[1]?.trim() ?? text;
  return text;
}

function isoToMs(iso: unknown): number {
  if (typeof iso !== 'string') return 0;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

/** Capped preview of arbitrary JSON-stringified content. Used for
 *  tool_use inputs (e.g. the shell command) and tool_result outputs so
 *  the renderer can show a one-glance hint without choking on 50 KB of
 *  file contents. */
const PREVIEW_CHARS = 240;
function preview(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS) + '…' : flat;
}

function turnId(ts: number, userInput: string): string {
  // djb2 — good enough to disambiguate identical prompts at different
  // times. Not cryptographic; we only need stable React keys.
  let h = 5381;
  const sample = userInput.slice(0, 64);
  for (let i = 0; i < sample.length; i++) {
    h = ((h << 5) + h) ^ sample.charCodeAt(i);
  }
  return `${ts}-${(h >>> 0).toString(36)}`;
}

interface ClaudeLine {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** Extract plain text from Claude's message.content (string or array of
 *  text parts). Tool-result and tool-use parts are NOT included here —
 *  callers handle those separately. */
function claudeTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const part = c as { type?: string; text?: unknown };
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

/** Walk Claude's transcript and emit one SessionTurn per real user prompt. */
export function readClaudeTurns(transcriptPath: string): SessionTurn[] {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch { return []; }
  const turns: SessionTurn[] = [];
  let current: SessionTurn | null = null;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj: ClaudeLine;
    try { obj = JSON.parse(line) as ClaudeLine; } catch { continue; }

    // Sidecar metadata lines we don't render. last-prompt/ai-title etc
    // carry useful debugging info but no turn content.
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const content = obj.message?.content;

    if (obj.type === 'user' && obj.message?.role === 'user') {
      // Two disjoint sub-cases: a real user prompt (string or array of
      // text parts) OR a tool_result attached to the previous turn.
      if (Array.isArray(content) && content.length > 0 &&
          (content[0] as { type?: string }).type === 'tool_result') {
        if (!current) continue;
        const part = content[0] as { content?: unknown; is_error?: boolean };
        const text = typeof part.content === 'string'
          ? part.content
          : JSON.stringify(part.content ?? '');
        current.progress.push({
          kind: 'tool_result',
          ok: !part.is_error,
          preview: preview(text),
        });
        continue;
      }

      const text = unwrapSlashCommand(claudeTextContent(content)).trim();
      if (!text) continue;
      if (isClaudeFraming(text)) continue;

      // Start of a new turn — push the previous one (with its recap
      // already populated) and reset.
      if (current) turns.push(current);
      const ts = isoToMs(obj.timestamp);
      current = {
        id: turnId(ts, text),
        ts,
        userInput: text,
        progress: [],
        recap: null,
      };
      continue;
    }

    if (obj.type === 'assistant' && obj.message?.role === 'assistant' &&
        Array.isArray(content)) {
      if (!current) continue;
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const part = c as { type?: string; text?: unknown; name?: unknown; input?: unknown };
        if (part.type === 'text' && typeof part.text === 'string') {
          current.progress.push({ kind: 'assistant', text: part.text });
          current.recap = part.text;
        } else if (part.type === 'tool_use' && typeof part.name === 'string') {
          current.progress.push({
            kind: 'tool_use',
            name: part.name,
            inputPreview: preview(JSON.stringify(part.input ?? {})),
          });
        }
        // 'thinking' parts are deliberately dropped — they're verbose
        // and not what the user is here to see.
      }
    }
  }
  if (current) turns.push(current);
  return capRecent(turns);
}

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: { type?: string; role?: string; content?: unknown };
}

function codexTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === 'string') { parts.push(c); continue; }
    if (!c || typeof c !== 'object') continue;
    const part = c as { type?: string; text?: unknown };
    if (
      (part.type === 'input_text' || part.type === 'output_text') &&
      typeof part.text === 'string'
    ) {
      parts.push(part.text);
    }
  }
  return parts.join('\n');
}

function isCodexFraming(text: string): boolean {
  const t = text.trim();
  return t.startsWith('<') && /<\w+/.test(t.slice(0, 80));
}

/** Walk Codex's rollout and emit turns. Codex lines we currently surface
 *  cover plain text only — tool calls show up as `event_msg` shapes we
 *  don't yet parse. Easy to extend without changing the SessionTurn
 *  shape. */
export function readCodexTurns(transcriptPath: string): SessionTurn[] {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch { return []; }
  const turns: SessionTurn[] = [];
  let current: SessionTurn | null = null;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj: CodexLine;
    try { obj = JSON.parse(line) as CodexLine; } catch { continue; }
    if (obj.type !== 'response_item') continue;
    if (obj.payload?.type !== 'message') continue;

    const role = obj.payload.role;
    const text = codexTextContent(obj.payload.content).trim();
    if (!text) continue;

    if (role === 'user' && !isCodexFraming(text)) {
      if (current) turns.push(current);
      const ts = isoToMs(obj.timestamp);
      current = {
        id: turnId(ts, text),
        ts,
        userInput: text,
        progress: [],
        recap: null,
      };
      continue;
    }
    if (role === 'assistant' && current) {
      current.progress.push({ kind: 'assistant', text });
      current.recap = text;
    }
    // 'developer' / 'system' roles are framing — skip.
  }
  if (current) turns.push(current);
  return capRecent(turns);
}

function capRecent(items: SessionTurn[]): SessionTurn[] {
  return items.length > MAX_TURNS ? items.slice(-MAX_TURNS) : items;
}

/** Resolve the right transcript and split it into turns. */
export function readSessionTurns(session: Session): SessionTurn[] {
  const sid = session.claudeSessionId;
  if (!sid) return [];
  if (session.backendId === 'claude-code') {
    return readClaudeTurns(claudeTranscriptPath(session.worktreePath, sid));
  }
  if (session.backendId === 'codex') {
    const file = findCodexTranscript(sid);
    if (!file) return [];
    return readCodexTurns(file);
  }
  return [];
}
