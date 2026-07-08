/**
 * MockAgentBackend — a fake agent that never launches a real CLI.
 *
 * Per PRD F2.6, the backend trait shipped with a mock from day 1; this
 * fills in the `'mock'` AgentBackendId that the enum already reserves.
 * It exists so the session lifecycle (spawn → live → kill/respawn) and
 * features layered on top of it (resume, permission-mode, revert) can be
 * driven deterministically in tests and headless/E2E runs without Claude
 * auth, API cost, or pty flakiness.
 *
 * The handle is a plain in-memory event emitter — no node-pty, so this
 * module stays importable outside an Electron runtime. `write()` echoes
 * back through `onData` so a terminal pane has something to render, and
 * `kill()` synchronously fires `onExit` so the SessionManager's
 * markExited path runs exactly as it would for a real pty.
 */

import type { AgentBackend, AgentHandle, AgentSpawnOpts } from './agentBackend.js';

let nextPid = 90000;

function makeHandle(): AgentHandle {
  const dataHandlers = new Set<(chunk: Buffer) => void>();
  const exitHandlers = new Set<(code: number | null, signal: number | null) => void>();
  let alive = true;
  const pid = nextPid++;

  const emitExit = (code: number | null): void => {
    if (!alive) return;
    alive = false;
    for (const h of exitHandlers) h(code, null);
  };

  return {
    pid,
    write(data: string): void {
      if (!alive) return;
      // Echo so a TerminalPane has bytes to show. Real backends get this
      // from the CLI's own stdout; the mock just mirrors input.
      const buf = Buffer.from(data, 'utf-8');
      for (const h of dataHandlers) h(buf);
    },
    resize(): void { /* no pty to resize */ },
    kill(): void { emitExit(0); },
    pause(): void { /* no-op */ },
    resume(): void { /* no-op */ },
    onData(handler): () => void {
      dataHandlers.add(handler);
      return () => dataHandlers.delete(handler);
    },
    onExit(handler): () => void {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
  };
}

export class MockAgentBackend implements AgentBackend {
  readonly id = 'mock' as const;

  // Always "installed" — there's nothing to find on PATH.
  async isInstalled(): Promise<boolean> {
    return true;
  }

  async spawn(_opts: AgentSpawnOpts): Promise<AgentHandle> {
    return makeHandle();
  }
}
