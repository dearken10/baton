/**
 * Run a project's setup script inside a freshly-created worktree.
 *
 * Per PRD F1.4: each project may define a setup hook that prepares a
 * new worktree (install deps, copy .env, etc.) before the agent
 * starts. v1 supports a shell script at one of:
 *   <projectRoot>/.code24/setup.sh
 *   <projectRoot>/code24-setup.sh
 * picked in that order. setup.json (declarative) is deferred.
 *
 * The script runs with `cwd = worktreePath` and the following env:
 *   CODE24_PROJECT_ROOT  — absolute path to the project root
 *   CODE24_WORKTREE_PATH — absolute path to the new worktree
 *   CODE24_BRANCH        — the worktree branch name
 *
 * Output (stdout + stderr) is captured and returned to the caller —
 * SessionManager passes errors up to the renderer so the user sees
 * the real reason a spawn failed, not just a generic "git error".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

export interface SetupScriptResult {
  /** True if a script was found and executed (regardless of exit code). */
  ran: boolean;
  /** Absolute path of the script, if found. */
  scriptPath: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const CANDIDATE_PATHS = ['.code24/setup.sh', 'code24-setup.sh'] as const;

/** Maximum bytes of captured stdout/stderr — protects against a runaway
 *  script flooding the main process with output. */
const MAX_BYTES = 256 * 1024;

/** Hard timeout — caps how long a script can hold up spawn. */
const TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

function findScript(projectRoot: string): string | null {
  for (const rel of CANDIDATE_PATHS) {
    const abs = path.join(projectRoot, rel);
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) return abs;
    } catch { /* not present */ }
  }
  return null;
}

export async function runSetupScript(args: {
  projectRoot: string;
  worktreePath: string;
  branch: string;
}): Promise<SetupScriptResult> {
  const scriptPath = findScript(args.projectRoot);
  if (!scriptPath) {
    return { ran: false, scriptPath: null, exitCode: 0, stdout: '', stderr: '' };
  }

  return new Promise<SetupScriptResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;

    const proc = spawn('/bin/sh', [scriptPath], {
      cwd: args.worktreePath,
      env: {
        ...process.env,
        CODE24_PROJECT_ROOT: args.projectRoot,
        CODE24_WORKTREE_PATH: args.worktreePath,
        CODE24_BRANCH: args.branch,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_BYTES) return;
      const s = chunk.toString('utf-8');
      stdoutBytes += s.length;
      stdout += s.slice(0, Math.max(0, MAX_BYTES - (stdoutBytes - s.length)));
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_BYTES) return;
      const s = chunk.toString('utf-8');
      stderrBytes += s.length;
      stderr += s.slice(0, Math.max(0, MAX_BYTES - (stderrBytes - s.length)));
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ran: true,
        scriptPath,
        exitCode: null,
        stdout,
        stderr: stderr + `\n[code24] failed to start setup script: ${err.message}`,
      });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({
        ran: true,
        scriptPath,
        exitCode: killed ? null : code,
        stdout,
        stderr: killed
          ? stderr + `\n[code24] setup script timed out after ${TIMEOUT_MS / 1000}s — killed.`
          : stderr,
      });
    });
  });
}
