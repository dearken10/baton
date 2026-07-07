/**
 * Tests for the sessionTurns parser. Each test writes a small JSONL
 * fixture to a tmpfile and runs the real reader against it, so we
 * exercise the file-IO path too. Shapes mirror what real Claude /
 * Codex transcripts look like — verified against actual ones in
 * `~/.claude/projects/` and `~/.codex/sessions/`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readClaudeTurns,
  readCodexTurns,
  truncateClaudeTranscriptBeforeTurn,
} from './sessionTurns.js';

const tmpfiles: string[] = [];
function writeFixture(lines: object[]): string {
  const file = path.join(
    os.tmpdir(),
    `session-turns-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  tmpfiles.push(file);
  return file;
}
afterEach(() => {
  while (tmpfiles.length) {
    try { fs.unlinkSync(tmpfiles.pop()!); } catch { /* ignore */ }
  }
});

describe('readClaudeTurns', () => {
  it('returns [] for a missing file', () => {
    expect(readClaudeTurns('/no/such/file.jsonl')).toEqual([]);
  });

  it('skips framing lines and starts at the real user prompt', () => {
    const file = writeFixture([
      {
        type: 'user', timestamp: '2026-06-16T00:00:00Z',
        message: { role: 'user', content: '<environment_context>cwd=/x</environment_context>' },
      },
      {
        type: 'user', timestamp: '2026-06-16T00:00:01Z',
        message: { role: 'user', content: 'hello world' },
      },
    ]);
    const turns = readClaudeTurns(file);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.userInput).toBe('hello world');
    expect(turns[0]?.progress).toEqual([]);
    expect(turns[0]?.recap).toBeNull();
  });

  it('groups assistant text, tool_use, tool_result under the active turn', () => {
    const file = writeFixture([
      {
        type: 'user', timestamp: '2026-06-16T00:00:00Z',
        message: { role: 'user', content: 'list the directory' },
      },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:01Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
        },
      },
      {
        type: 'user', timestamp: '2026-06-16T00:00:02Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', content: 'a\nb\nc', is_error: false }],
        },
      },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:03Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Found 3 files.' }] },
      },
    ]);
    const turns = readClaudeTurns(file);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.userInput).toBe('list the directory');
    expect(t.progress).toEqual([
      { kind: 'tool_use', name: 'Bash', inputPreview: '{"command":"ls"}' },
      { kind: 'tool_result', ok: true, preview: 'a b c' },
      { kind: 'assistant', text: 'Found 3 files.' },
    ]);
    expect(t.recap).toBe('Found 3 files.');
  });

  it('uses the LAST assistant text as recap (not the first)', () => {
    const file = writeFixture([
      {
        type: 'user', timestamp: '2026-06-16T00:00:00Z',
        message: { role: 'user', content: 'do the thing' },
      },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'thinking through it' }] },
      },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:02Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done — here is the answer' }] },
      },
    ]);
    expect(readClaudeTurns(file)[0]?.recap).toBe('done — here is the answer');
  });

  it('starts a new turn on each real user prompt', () => {
    const file = writeFixture([
      { type: 'user', timestamp: '2026-06-16T00:00:00Z', message: { role: 'user', content: 'first' } },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
      },
      { type: 'user', timestamp: '2026-06-16T00:00:02Z', message: { role: 'user', content: 'second' } },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:03Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] },
      },
    ]);
    const turns = readClaudeTurns(file);
    expect(turns.map((t) => t.userInput)).toEqual(['first', 'second']);
    expect(turns.map((t) => t.recap)).toEqual(['reply 1', 'reply 2']);
  });

  it('leaves recap null when the turn ends mid-flight on a tool call', () => {
    const file = writeFixture([
      { type: 'user', timestamp: '2026-06-16T00:00:00Z', message: { role: 'user', content: 'kick off work' } },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 10' } }] },
      },
    ]);
    const turns = readClaudeTurns(file);
    expect(turns[0]?.recap).toBeNull();
    expect(turns[0]?.progress).toHaveLength(1);
  });

  it('drops `thinking` parts from progress', () => {
    const file = writeFixture([
      { type: 'user', timestamp: '2026-06-16T00:00:00Z', message: { role: 'user', content: 'go' } },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering...' }] },
      },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:02Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      },
    ]);
    expect(readClaudeTurns(file)[0]?.progress).toEqual([
      { kind: 'assistant', text: 'ok' },
    ]);
  });

  it('unwraps Claude slash commands so the userInput is the command name', () => {
    const file = writeFixture([
      {
        type: 'user', timestamp: '2026-06-16T00:00:00Z',
        message: {
          role: 'user',
          content: '<command-message>review</command-message><command-name>/review</command-name>',
        },
      },
    ]);
    expect(readClaudeTurns(file)[0]?.userInput).toBe('/review');
  });

  it('gives each turn a stable, non-colliding id', () => {
    const file = writeFixture([
      { type: 'user', timestamp: '2026-06-16T00:00:00Z', message: { role: 'user', content: 'same prompt' } },
      { type: 'user', timestamp: '2026-06-16T00:00:01Z', message: { role: 'user', content: 'same prompt' } },
    ]);
    const turns = readClaudeTurns(file);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.id).not.toBe(turns[1]?.id);
  });
});

describe('truncateClaudeTranscriptBeforeTurn', () => {
  // A 3-turn transcript with tool calls interleaved, mirroring a real
  // session. Returns the file path plus the parsed turns so tests can
  // grab stable ids the way the renderer does.
  function threeTurnFixture(): { file: string; ids: string[] } {
    const file = writeFixture([
      { type: 'user', timestamp: '2026-06-16T00:00:00Z', message: { role: 'user', content: 'first prompt' } },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:01Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      },
      {
        type: 'user', timestamp: '2026-06-16T00:00:02Z',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok', is_error: false }] },
      },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:03Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply one' }] },
      },
      { type: 'user', timestamp: '2026-06-16T00:00:04Z', message: { role: 'user', content: 'second prompt' } },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:05Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply two' }] },
      },
      { type: 'user', timestamp: '2026-06-16T00:00:06Z', message: { role: 'user', content: 'third prompt' } },
      {
        type: 'assistant', timestamp: '2026-06-16T00:00:07Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'reply three' }] },
      },
    ]);
    return { file, ids: readClaudeTurns(file).map((t) => t.id) };
  }

  it('drops the target turn and everything after it, keeping earlier turns intact', () => {
    const { file, ids } = threeTurnFixture();
    // Revert to before turn #2 (0-based index 1).
    const res = truncateClaudeTranscriptBeforeTurn(file, ids[1]!);
    expect(res).toEqual({ found: true, isEmptyAfter: false });

    const remaining = readClaudeTurns(file);
    expect(remaining.map((t) => t.userInput)).toEqual(['first prompt']);
    // The surviving turn keeps its full progress + recap — we only cut
    // at the *next* turn's user line, never inside the kept turn.
    expect(remaining[0]?.recap).toBe('reply one');
    expect(remaining[0]?.progress).toEqual([
      { kind: 'tool_use', name: 'Bash', inputPreview: '{"command":"ls"}' },
      { kind: 'tool_result', ok: true, preview: 'ok' },
      { kind: 'assistant', text: 'reply one' },
    ]);
  });

  it('empties the file when reverting the very first turn', () => {
    const { file, ids } = threeTurnFixture();
    const res = truncateClaudeTranscriptBeforeTurn(file, ids[0]!);
    expect(res).toEqual({ found: true, isEmptyAfter: true });
    expect(readClaudeTurns(file)).toEqual([]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('');
  });

  it('keeps the last turn when reverting it (drops only that turn)', () => {
    const { file, ids } = threeTurnFixture();
    const res = truncateClaudeTranscriptBeforeTurn(file, ids[2]!);
    expect(res).toEqual({ found: true, isEmptyAfter: false });
    expect(readClaudeTurns(file).map((t) => t.userInput)).toEqual([
      'first prompt', 'second prompt',
    ]);
  });

  it('leaves the file untouched and reports not-found for an unknown id', () => {
    const { file } = threeTurnFixture();
    const before = fs.readFileSync(file, 'utf-8');
    const res = truncateClaudeTranscriptBeforeTurn(file, 'nope-12345');
    expect(res).toEqual({ found: false, isEmptyAfter: false });
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('returns not-found for a missing file', () => {
    expect(truncateClaudeTranscriptBeforeTurn('/no/such/file.jsonl', 'x'))
      .toEqual({ found: false, isEmptyAfter: false });
  });
});

describe('readCodexTurns', () => {
  it('skips developer/system framing and pairs user with assistant', () => {
    const file = writeFixture([
      { type: 'session_meta', payload: {} },
      {
        type: 'response_item', timestamp: '2026-06-16T00:00:00Z',
        payload: {
          type: 'message', role: 'developer',
          content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }],
        },
      },
      {
        type: 'response_item', timestamp: '2026-06-16T00:00:01Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi codex' }] },
      },
      {
        type: 'response_item', timestamp: '2026-06-16T00:00:02Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello there' }] },
      },
    ]);
    const turns = readCodexTurns(file);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.userInput).toBe('hi codex');
    expect(turns[0]?.recap).toBe('hello there');
  });
});
