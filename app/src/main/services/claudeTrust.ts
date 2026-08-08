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

/** Where Claude keeps `.claude.json`. Defaults to the home dir, but a
 *  baton-managed login relocates the whole config via CLAUDE_CONFIG_DIR,
 *  so trust must be written into that dir instead. */
function claudeJsonPath(configDir?: string): string {
  return path.join(configDir ?? os.homedir(), '.claude.json');
}

interface ClaudeConfig {
  projects?: Record<string, ProjectEntry>;
  hasCompletedOnboarding?: boolean;
  theme?: string;
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
 * Idempotent. Trusts `cwd` in Claude's config, and — for a baton-managed
 * login's relocated config dir — also marks first-run onboarding complete.
 * Resolves symlinks first because that's the form Claude stores. Silent on
 * any error — the app must keep working even if the config is locked.
 *
 * Onboarding: a browser login's isolated config dir has never run Claude's
 * setup wizard (theme picker etc.). Interactive `claude` there shows the
 * wizard and ignores `--resume`, so a login switch starts a fresh
 * conversation instead of resuming. Seeding `hasCompletedOnboarding` (the
 * same flag the machine's own ~/.claude carries) skips the wizard. Only
 * done when `configDir` is set — we never touch the user's real ~/.claude.
 */
export function trustDirectoryForClaude(cwd: string, configDir?: string): void {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* fall back to cwd */ }

  const claudeJson = claudeJsonPath(configDir);
  let cfg: ClaudeConfig;
  try {
    const raw = fs.readFileSync(claudeJson, 'utf-8');
    cfg = JSON.parse(raw) as ClaudeConfig;
  } catch {
    // File doesn't exist or is unreadable. Don't try to create it
    // ourselves — that could clobber Claude's own setup.
    return;
  }

  let changed = false;

  // Trust the cwd.
  cfg.projects = cfg.projects ?? {};
  const existing = cfg.projects[real];
  if (existing?.hasTrustDialogAccepted !== true) {
    cfg.projects[real] = { ...STUB, ...(existing ?? {}), hasTrustDialogAccepted: true };
    changed = true;
  }

  // Skip the first-run onboarding wizard in a login's config dir so
  // interactive `claude` honours --resume instead of starting fresh.
  if (configDir && cfg.hasCompletedOnboarding !== true) {
    cfg.hasCompletedOnboarding = true;
    if (cfg.theme === undefined) cfg.theme = 'dark';
    changed = true;
  }

  if (!changed) return;

  try {
    // Atomic-ish write via a temp file in the same dir.
    const tmp = claudeJson + '.baton.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, claudeJson);
  } catch {
    // best-effort
  }
}
