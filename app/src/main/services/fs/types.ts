/**
 * Fs abstraction — the boundary between "filesystem ops on this Mac"
 * and "filesystem ops on a remote host". Every IPC handler that touches
 * a path resolves a `BatonFs` from the path's owning project/session
 * (via the registry) and uses it instead of raw `node:fs`.
 *
 * Stage 2: LocalFs delegates to fsp/child_process; RemoteFs runs each
 * operation through a long-lived OpenSSH ControlMaster channel.
 *
 * Stage 3 (post-v1) would swap RemoteFs for a Node daemon RPC — same
 * interface, much lower per-op latency. Don't expand this surface
 * unless multiple call sites need the new method.
 */

import type { Readable } from 'node:stream';

export type FileKind = 'file' | 'dir' | 'symlink' | 'other';

export interface FsStat {
  kind: FileKind;
  size: number;
  mtimeMs: number;
}

export interface FsDirent {
  name: string;
  kind: FileKind;
}

export interface ReadFileOpts {
  /** Reject files larger than this many bytes and return tooLarge=true. */
  maxBytes?: number;
}

export interface ReadFileResult {
  /** UTF-8 contents (empty when tooLarge or binary). */
  content: string;
  size: number;
  mtimeMs: number;
  /** Detected NUL byte in the first 4 KB → caller should render the
   *  binary-viewer fallback. Always false on RemoteFs since the remote
   *  reader returns base64 unconditionally; remote callers that need
   *  binary detection use readFileBinary instead. */
  binary: boolean;
  tooLarge: boolean;
}

export interface ReadBinaryOpts {
  maxBytes?: number;
}

export interface ReadBinaryResult {
  /** Base64-encoded bytes. Empty when tooLarge. */
  data: string;
  size: number;
  mtimeMs: number;
  tooLarge: boolean;
}

export interface WriteFileOpts {
  /** If set, refuse the write when the on-disk mtime exceeds this
   *  threshold + 1 ms (i.e. someone edited the file out-of-band).
   *  Returns stale=true; caller can retry with force=true. */
  knownMtimeMs?: number;
  force?: boolean;
}

export interface WriteFileResult {
  ok: boolean;
  mtimeMs: number;
  stale: boolean;
}

export interface ExecOpts {
  /** Working directory for the command. Required — every call site has
   *  a well-defined cwd (worktree path), and an unscoped exec is almost
   *  certainly a bug. */
  cwd: string;
  /** Extra env vars for the child process. Inherited PATH on local,
   *  the remote shell's PATH for remote. */
  env?: Record<string, string>;
  /** Wall-clock cap. Returns timedOut=true on overrun. */
  timeoutMs?: number;
  /** Optional UTF-8 stdin (or Buffer/Readable for binary streams). */
  stdin?: string | Buffer | Readable;
  /** Cap stdout bytes returned. Defaults to 8 MB. */
  maxStdoutBytes?: number;
}

export interface ExecResult {
  /** UTF-8 string output. For binary-safe consumers, use execBuffer. */
  stdout: string;
  stderr: string;
  /** Exit code, or null when the process was killed by a signal / timed
   *  out before exiting. */
  code: number | null;
  timedOut: boolean;
}

export interface ExecBufferResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  timedOut: boolean;
}

/** Long-running pty spawn — same shape as node-pty.IPty surface that
 *  AgentHandle needs. Local: node-pty directly. Remote: spawn
 *  `ssh -tt user@host -- "<command>"` as the pty subprocess. */
export interface PtySpawnOpts {
  /** Command on the *target* host. Local: the binary in PATH. Remote:
   *  a single shell line evaluated by `sh -c` on the remote (so the
   *  caller can compose `cd "$cwd" && exec claude ...`). */
  command: string;
  /** Argv. For local, passed verbatim to node-pty. For remote, joined
   *  into the shell line. */
  args: string[];
  /** cwd ON THE TARGET HOST (i.e. a path the target can stat). */
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Optional list of `(port, localPort)` pairs to reverse-forward over
   *  SSH (`-R localPort:localhost:port`). Used by the hook bridge. */
  reverseForward?: Array<{ remotePort: number; localPort: number }>;
}

export interface PtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  pause(): void;
  resume(): void;
  onData(handler: (chunk: Buffer) => void): () => void;
  onExit(handler: (exitCode: number | null, signal: number | null) => void): () => void;
}

export interface BatonFs {
  /** "local" or a ConnectionProfile id. */
  readonly id: string;
  /** True when this Fs serves the local Mac filesystem. */
  readonly isLocal: boolean;

  /** Returns null if the path doesn't exist. */
  stat(absPath: string): Promise<FsStat | null>;
  exists(absPath: string): Promise<boolean>;
  /** Directory listing, sorted dirs-first then alphabetical by the
   *  caller. Returns [] if the path doesn't exist or isn't readable. */
  readdir(absPath: string): Promise<FsDirent[]>;
  mkdir(absPath: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(absPath: string, opts?: { recursive?: boolean; force?: boolean; trash?: boolean }): Promise<void>;
  rename(fromAbs: string, toAbs: string): Promise<void>;
  /** Recursive copy. errorOnExist mirrors fsp.cp default for safety. */
  cp(fromAbs: string, toAbs: string, opts?: { recursive?: boolean; errorOnExist?: boolean }): Promise<void>;

  readFile(absPath: string, opts?: ReadFileOpts): Promise<ReadFileResult>;
  readFileBinary(absPath: string, opts?: ReadBinaryOpts): Promise<ReadBinaryResult>;
  writeFile(absPath: string, content: string, opts?: WriteFileOpts): Promise<WriteFileResult>;

  /** Run a command on the target host. Output is UTF-8; for binary
   *  output (e.g. git's NUL-separated grep), use execBuffer. */
  exec(command: string, args: readonly string[], opts: ExecOpts): Promise<ExecResult>;
  execBuffer(command: string, args: readonly string[], opts: ExecOpts): Promise<ExecBufferResult>;

  /** Spawn a long-running pty. */
  spawnPty(opts: PtySpawnOpts): Promise<PtyHandle>;
}
