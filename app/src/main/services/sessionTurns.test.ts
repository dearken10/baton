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
import { readClaudeTurns, readCodexTurns } from './sessionTurns.js';

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
