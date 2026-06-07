/**
 * AgentBackend — the trait every agent CLI implements.
 *
 * Per PRD F2.6: define the interface from day 1. v1 ships
 * ClaudeCodeBackend + MockAgentBackend; Codex is v2.
 *
 * The backend is responsible for spawning the agent CLI in a pty,
 * surfacing pty data, and translating its exit / lifecycle signals
 * into status transitions. The SessionManager owns the per-session
 * state machine that consumes those signals.
 */

import type { AgentBackendId } from '../../shared/ipc.js';

export interface AgentSpawnOpts {
  /** Stable session id. The backend uses it to scope hook events. */
  sessionId: string;
  /** Working directory for the agent process. */
  cwd: string;
  /** Initial pty size. */
  cols: number;
  rows: number;
  /** Env overrides (e.g. forced TERM=xterm-256color). */
  env?: Record<string, string>;
}

export interface AgentHandle {
  /** Underlying pty pid. */
  readonly pid: number;
  /** Push bytes to the pty. */
  write(data: string): void;
  /** Resize the pty. */
  resize(cols: number, rows: number): void;
  /** SIGTERM the pty group and clean up. Idempotent. */
  kill(signal?: NodeJS.Signals): void;
  /** SIGSTOP the pty. The process stays alive but stops scheduling.
   *  Used by the idle-timeout auto-pause (PRD F11.4). */
  pause(): void;
  /** SIGCONT the pty so it resumes work. Pair with pause(). */
  resume(): void;
  /** Subscribe to pty stdout/stderr. Returns an unsubscribe. */
  onData(handler: (chunk: Buffer) => void): () => void;
  /** Subscribe to exit. Returns an unsubscribe. */
  onExit(handler: (exitCode: number | null, signal: number | null) => void): () => void;
}

export interface AgentBackend {
  readonly id: AgentBackendId;
  /** Is the CLI installed on PATH? Used by onboarding + spawn-time check. */
  isInstalled(): Promise<boolean>;
  /** Spawn the agent. Resolves once the pty is up; rejects on spawn failure. */
  spawn(opts: AgentSpawnOpts): Promise<AgentHandle>;
}
