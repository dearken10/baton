/**
 * Read a session's user-prompt history from the agent's transcript file.
 *
 * Both Claude Code and Codex log every turn to disk as JSONL; we parse
 * the lines, filter framing/tool-result entries, and return what the
 * user actually typed. Source of truth lives with the agent, not with
 * us — we don't try to track or persist it.
 *
 * Returns an array ordered oldest → newest. Empty for shell sessions,
 * sessions with no transcript yet, or unreadable files.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Session } from '../../shared/ipc.js';
import { findCodexTranscript } from './codexTranscriptReader.js';

/** Mirror of sessionManager.claudeTranscriptPath — kept here so this
 *  module has no dependency on the (large) sessionManager. Claude
 *  resolves symlinks on the cwd then replaces `/`, `.`, `_` with `-`.
 *  Verified empirically against real `~/.claude/projects/` dir names. */
function claudeTranscriptPath(cwd: string, claudeSessionId: string): string {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* fall back to cwd */ }
  const sanitized = real.replace(/[/._]/g, '-');
  return path.join(
    os.homedir(), '.claude', 'projects', sanitized, `${claudeSessionId}.jsonl`,
  );
}

export interface PromptEntry {
  /** Wall-clock ms when the prompt was submitted (epoch). */
  ts: number;
  /** What the user typed, with framing stripped. May be multi-line. */
  text: string;
}

/** Hard cap on history length per session — protects the renderer from
 *  monster transcripts (multi-day sessions can hit thousands of turns). */
const MAX_PROMPTS = 500;

/** Claude wraps these system-injected user messages around the real
 *  prompt; treat them as framing and skip. Slash commands
 *  (`<command-message>` / `<command-name>`) are NOT here — those are
 *  things the user explicitly invoked, so they belong in the history. */
const CLAUDE_FRAMING_TAGS = new Set([
  'environment_context',
  'system_instruction',
  'user_instructions',
  'local-command-stdout',
  'system-reminder',
  'IMPORTANT-DO_NOT_DEVIATE',
]);

/** True for Claude/Codex strings that are system framing wrapped in an
 *  XML-style tag (e.g. `<environment_context>...`), as opposed to real
 *  user content that may incidentally contain `<`. */
function isClaudeFraming(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('<')) return false;
  const match = t.match(/^<([\w-]+)/);
  if (!match) return false;
  return CLAUDE_FRAMING_TAGS.has(match[1] ?? '');
}

function isCodexFraming(text: string): boolean {
  // Codex framing always starts with a tag and is unrecognisable from
  // real prompts only on the rare line that opens with `<word>`. Match
  // the same heuristic codexTranscriptReader uses for `readRecentCodexTurn`.
  const t = text.trim();
  return t.startsWith('<') && /<\w+/.test(t.slice(0, 80));
}

/** Best-effort: pull a slash-command name out of Claude's wrapped form
 *  so the history shows `/maestro-tick` rather than the raw XML soup. */
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

/** Walk Claude's transcript and return the user prompts in order. */
export function readClaudePrompts(transcriptPath: string): PromptEntry[] {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch { return []; }
  const out: PromptEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj: {
      type?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown };
    };
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'user') continue;
    if (obj.message?.role !== 'user') continue;

    // Extract text — either the string content itself, or the
    // concatenation of any `text`-type entries in the content array.
    // Pure tool_result lines collapse to '' and are filtered below.
    const content = obj.message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const part = c as { type?: string; text?: unknown };
        if (part.type === 'text' && typeof part.text === 'string') {
          parts.push(part.text);
        }
      }
      text = parts.join('\n');
    }

    text = unwrapSlashCommand(text).trim();
    if (!text) continue;
    if (isClaudeFraming(text)) continue;

    out.push({ ts: isoToMs(obj.timestamp), text });
  }
  return capRecent(out);
}

/** Walk Codex's rollout transcript and return the user prompts in order. */
export function readCodexPrompts(transcriptPath: string): PromptEntry[] {
  let raw: string;
  try { raw = fs.readFileSync(transcriptPath, 'utf-8'); }
  catch { return []; }
  const out: PromptEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj: {
      type?: string;
      timestamp?: string;
      payload?: { type?: string; role?: string; content?: unknown };
    };
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'response_item') continue;
    if (obj.payload?.type !== 'message') continue;
    if (obj.payload.role !== 'user') continue;

    const content = obj.payload.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const part = c as { type?: string; text?: unknown };
        if (part.type === 'input_text' && typeof part.text === 'string') {
          parts.push(part.text);
        }
      }
      text = parts.join('\n');
    }

    text = text.trim();
    if (!text) continue;
    if (isCodexFraming(text)) continue;

    out.push({ ts: isoToMs(obj.timestamp), text });
  }
  return capRecent(out);
}

function capRecent(items: PromptEntry[]): PromptEntry[] {
  return items.length > MAX_PROMPTS ? items.slice(-MAX_PROMPTS) : items;
}

/** Resolve the right transcript path for a session and parse it. */
export function readPromptHistory(session: Session): PromptEntry[] {
  const sid = session.claudeSessionId;
  if (!sid) return [];
  if (session.backendId === 'claude-code') {
    return readClaudePrompts(claudeTranscriptPath(session.worktreePath, sid));
  }
  if (session.backendId === 'codex') {
    const file = findCodexTranscript(sid);
    if (!file) return [];
    return readCodexPrompts(file);
  }
  // 'shell' and 'mock' have no transcript by design.
  return [];
}
