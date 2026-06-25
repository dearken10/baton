/**
 * SshConnection — one long-lived OpenSSH ControlMaster per profile.
 *
 * Every fs/exec op for a remote profile multiplexes through the same
 * SSH connection (set up once, kept alive until the app exits or the
 * user deletes the profile). This trades a one-time ~300 ms ssh
 * handshake for ~30 ms per subsequent op, which is what makes remote
 * file-tree polling tolerable.
 *
 * Reconnect: when the master process dies (network drop, sshd restart),
 * we re-launch it with exponential backoff (2s → 30s). Anything queued
 * while disconnected fails fast so the renderer can show the banner;
 * the next op after reconnect succeeds.
 *
 * NOTE: pty sessions DO NOT multiplex through the master — they spawn
 * their own `ssh -tt user@host` with `-S <ctrl-path>` so they reuse the
 * existing TCP connection but get their own pseudo-tty.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type {
  ConnectionProbeStatus,
  ConnectionProfile,
} from '../../../shared/ipc.js';
import { emit } from '../eventBus.js';
import { getDatabase } from '../../database/index.js';
import { batonHome } from '../../paths.js';

const sshDir = (): string => join(batonHome(), 'ssh');

const RECONNECT_INTERVALS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

interface RawExecResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  timedOut: boolean;
}

/** Construct the path baton uses for the ControlMaster socket. Kept
 *  short — macOS caps Unix socket paths at 104 bytes, and OpenSSH
 *  refuses sockets whose path is too long. */
function controlPathFor(profileId: string): string {
  // 12-char prefix is enough to disambiguate; we tag with the host so
  // the user can recognise stale sockets via `ls`.
  return join(sshDir(), `cm-${profileId.slice(0, 12)}.sock`);
}

export class SshConnection {
  private state: ConnectionState = 'idle';
  private master: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  /** Reconnect attempts since the last successful boot. */
  private attempts = 0;
  /** Scheduled reconnect; null when we're connected or not reconnecting. */
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(public profile: ConnectionProfile) {}

  controlPath(): string {
    return controlPathFor(this.profile.id);
  }

  /** Ensure the master is up. Resolves once `ssh -O check` passes. */
  ensureMaster(): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.startMaster()
      .finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startMaster(): Promise<void> {
    mkdirSync(sshDir(), { recursive: true });
    // Stale socket from a previous run / crash — `ssh -M` refuses to
    // start if the path already exists, so clean it first. The peer is
    // long gone, so unlink is safe.
    try { unlinkSync(this.controlPath()); } catch { /* not present */ }

    this.setState('connecting');

    // -M  master mode
    // -N  no remote command — keep the foreground attached as the
    //     master itself, so we can observe exit and reconnect.
    // -o ServerAliveInterval=20 / CountMax=3 — drop the connection in
    //     ~60s of silence so we can flip to "disconnected" without
    //     waiting on TCP keepalive timeouts.
    //
    // We deliberately DO NOT set ControlPersist: with `-M -N` plus
    // ControlPersist, OpenSSH forks the master into the background
    // and the foreground process exits with code 0 — which our exit
    // handler would (incorrectly) classify as a failed startup. By
    // omitting ControlPersist the foreground stays alive as the
    // master for the entire connection lifetime.
    const baseArgs = this.sshBaseArgs();
    const masterArgs: string[] = [
      ...baseArgs,
      '-M', '-N',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      `${this.profile.user}@${this.profile.host}`,
    ];

    return new Promise<void>((resolve, reject) => {
      const child = spawn('ssh', masterArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.master = child;
      let stderrBuf = '';
      let settled = false;

      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => {
        stderrBuf += chunk;
        if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        this.master = null;
        this.setState('disconnected', 'error');
        reject(err);
      });

      child.on('exit', (code) => {
        const prevState = this.state;
        this.master = null;
        if (!settled) {
          // OpenSSH backgrounds the master with `-f` or ControlPersist
          // and the foreground exits cleanly. We don't use either, but
          // be defensive: if the foreground exits with 0 BEFORE the
          // socket-readiness poll fires, let the poll complete normally
          // — the socket may still appear. Only fail-fast on non-zero
          // exit codes during startup.
          if (code === 0) return;
          settled = true;
          this.setState('disconnected', code === 255 ? 'unreachable' : 'error');
          reject(new Error(
            `ssh master exited (code ${code ?? 'null'}): ${stderrBuf.trim().slice(-400)}`
          ));
          return;
        }
        // Failure AFTER startup → start the reconnect loop, unless the
        // app is shutting us down (we set state='idle' there).
        if (prevState === 'connected') {
          this.setState('disconnected', 'unreachable');
          this.scheduleReconnect();
        }
      });

      // Poll for the socket file to appear, then run `ssh -O check`.
      // Master may emit no stdout — the socket is the only ready signal.
      const startCheck = async (): Promise<void> => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if (existsSync(this.controlPath())) {
            const ok = await this.runCheck();
            if (ok) {
              if (settled) return;
              settled = true;
              this.attempts = 0;
              this.setState('connected', 'success');
              resolve();
              return;
            }
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        if (settled) return;
        settled = true;
        // Timed out waiting on the socket. Could be auth prompt,
        // host key prompt, or a slow link. BatchMode=yes means
        // anything interactive fails fast in stderr.
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        this.setState('disconnected', 'timeout');
        reject(new Error(
          `ssh master didn't come up in 8 s: ${stderrBuf.trim().slice(-400) || 'no stderr'}`
        ));
      };
      void startCheck();
    });
  }

  /** ssh -O check via the control socket. Returns true on success. */
  private runCheck(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        'ssh',
        [
          '-o', 'BatchMode=yes',
          '-S', this.controlPath(),
          '-O', 'check',
          `${this.profile.user}@${this.profile.host}`,
        ],
        { timeout: 4000 },
        (err) => resolve(!err)
      );
    });
  }

  /** Run a non-interactive command over the master. The master must
   *  be up; callers go through ensureMaster() first. */
  exec(args: { command: string; timeoutMs?: number; stdin?: string | Buffer | Readable; maxStdoutBytes?: number }): Promise<RawExecResult> {
    return new Promise((resolve) => {
      const childArgs: string[] = [
        '-o', 'BatchMode=yes',
        '-S', this.controlPath(),
        `${this.profile.user}@${this.profile.host}`,
        '--',
        args.command,
      ];
      const child = spawn('ssh', childArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const errBufs: Buffer[] = [];
      let stdoutLen = 0;
      const stdoutCap = args.maxStdoutBytes ?? 8 * 1024 * 1024;
      let timedOut = false;
      const timer = args.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }, args.timeoutMs)
        : null;

      child.stdout.on('data', (c: Buffer) => {
        stdoutLen += c.length;
        if (stdoutLen <= stdoutCap) out.push(c);
      });
      child.stderr.on('data', (c: Buffer) => errBufs.push(c));
      child.on('error', () => {
        if (timer) clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(errBufs),
          code: null,
          timedOut,
        });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(errBufs),
          code,
          timedOut,
        });
      });
      if (args.stdin != null) {
        if (args.stdin instanceof Readable) {
          args.stdin.pipe(child.stdin);
        } else {
          try {
            child.stdin.write(args.stdin);
            child.stdin.end();
          } catch { /* ignore */ }
        }
      } else {
        try { child.stdin.end(); } catch { /* ignore */ }
      }
    });
  }

  /** Returns the SSH-CLI args every child of this profile needs
   *  (BatchMode, port, key, control-path, control-master). Used by the
   *  pty spawner to attach to the same master without re-prompting. */
  sshBaseArgs(extra?: string[]): string[] {
    if (!this.profile.host || !this.profile.user) {
      throw new Error(`profile ${this.profile.id} is missing host or user`);
    }
    const args: string[] = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=accept-new',
    ];
    if (this.profile.port && this.profile.port !== 22) {
      args.push('-p', String(this.profile.port));
    }
    if (this.profile.authMethod === 'key' && this.profile.authKeyPath) {
      args.push('-i', this.profile.authKeyPath);
    }
    args.push('-S', this.controlPath());
    if (extra) args.push(...extra);
    return args;
  }

  getState(): ConnectionState {
    return this.state;
  }

  /** Tear down for good (profile delete or app shutdown). */
  shutdown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.state = 'idle';
    if (this.master) {
      // ssh -O exit cleanly closes the master.
      try {
        execFile('ssh', [
          '-S', this.controlPath(),
          '-O', 'exit',
          `${this.profile.user}@${this.profile.host}`,
        ], () => { /* best-effort */ });
      } catch { /* ignore */ }
      try { this.master.kill('SIGKILL'); } catch { /* ignore */ }
      this.master = null;
    }
    try { unlinkSync(this.controlPath()); } catch { /* not present */ }
  }

  /** Replace the cached profile after the user edits it (host/auth/etc).
   *  Triggers a reconnect on next use. */
  updateProfile(next: ConnectionProfile): void {
    this.profile = next;
    if (this.state === 'connected') {
      // Force a tear-down so the next ensureMaster() picks up the new
      // host/auth. We don't reconnect eagerly — the next request will.
      this.shutdown();
      this.state = 'disconnected';
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = RECONNECT_INTERVALS_MS[
      Math.min(this.attempts, RECONNECT_INTERVALS_MS.length - 1)
    ] ?? 30_000;
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureMaster().catch(() => {
        if (this.state !== 'connected') this.scheduleReconnect();
      });
    }, delay);
  }

  /** Force an immediate reconnect (clears backoff state). Called from
   *  the renderer's "Reconnect now" action. */
  async reconnectNow(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempts = 0;
    if (this.state === 'connected') {
      this.shutdown();
      this.state = 'disconnected';
    }
    await this.ensureMaster();
  }

  /** Update internal state + persist lastStatus to SQLite + emit a
   *  connection.updated event so the renderer's chip / badge updates
   *  without a poll. */
  private setState(next: ConnectionState, probe?: ConnectionProbeStatus): void {
    this.state = next;
    if (probe) {
      try {
        getDatabase()
          .prepare(
            'UPDATE connection_profiles SET last_status = ?, last_probed_at = ? WHERE id = ?'
          )
          .run(probe, Date.now(), this.profile.id);
      } catch { /* best-effort */ }
      this.profile = {
        ...this.profile,
        lastStatus: probe,
        lastProbedAt: Date.now(),
      };
      emit({ type: 'connection.updated', profile: this.profile });
    }
  }
}
