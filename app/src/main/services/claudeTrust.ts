/**
 * Pre-trust a directory in Claude's user config so the spawned
 * Claude CLI doesn't sit on the "Do you trust this directory?"
 * prompt — without this, SessionStart never fires until the user
 * acknowledges the prompt, which means the session's
 * claude_session_id never lands in our DB. On restart, the session
 * then looks ended.
 *
 * Mechanism (verified empirically):
 *   - Trust is stored in ~/.claude.json under
 *     `projects[<absolute-real-path>].hasTrustDialogAccepted = true`.
 *   - The key is the realpath-resolved absolute path.
 *   - If the entry is missing, Claude shows the prompt; if it's
 *     present with the flag set, Claude proceeds immediately.
 *
 * We add a minimal stub matching what Claude itself writes after the
 * user clicks "Trust". Other fields can be omitted.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

interface ClaudeConfig {
  projects?: Record<string, ProjectEntry>;
}
interface ProjectEntry {
  hasTrustDialogAccepted?: boolean;
  allowedTools?: string[];
  mcpContextUris?: string[];
  mcpServers?: Record<string, unknown>;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  [k: string]: unknown;
}

const STUB: ProjectEntry = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: true,
};

/**
 * Idempotent. Adds `cwd` to Claude's trusted projects if it isn't
 * already. Resolves symlinks first because that's the form Claude
 * stores. Silent on any error — the app must keep working even if
 * the user's Claude config is locked / unreadable.
 */
export function trustDirectoryForClaude(cwd: string): void {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* fall back to cwd */ }

  let cfg: ClaudeConfig;
  try {
    const raw = fs.readFileSync(CLAUDE_JSON, 'utf-8');
    cfg = JSON.parse(raw) as ClaudeConfig;
  } catch {
    // File doesn't exist or is unreadable. Don't try to create it
    // ourselves — that could clobber Claude's own setup.
    return;
  }

  cfg.projects = cfg.projects ?? {};
  const existing = cfg.projects[real];
  if (existing?.hasTrustDialogAccepted === true) return;

  cfg.projects[real] = { ...STUB, ...(existing ?? {}), hasTrustDialogAccepted: true };

  try {
    // Atomic-ish write via a temp file in the same dir.
    const tmp = CLAUDE_JSON + '.code24.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, CLAUDE_JSON);
  } catch {
    // best-effort
  }
}
