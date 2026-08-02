/**
 * Pre-trust a directory in Codex's user config so `codex` doesn't sit
 * on its workspace-trust prompt before firing SessionStart.
 *
 * Mechanism (verified by inspecting an existing ~/.codex/config.toml):
 *   - Trust is stored as a per-project table:
 *       [projects."/abs/path"]
 *       trust_level = "trusted"
 *   - The path key is the absolute (realpath) directory.
 *
 * We append-only — never reparse or rewrite the rest of the user's
 * config — so we can't corrupt their auth / provider / model blocks
 * even if their TOML is more elaborate than ours.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function codexConfigPath(codexHome?: string): string {
  const home =
    codexHome ?? process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

/**
 * Idempotent. Marks `cwd` trusted in `~/.codex/config.toml` if it
 * isn't already. Silent on any error — keep the app working even if
 * the user's Codex config is locked / missing.
 */
export function trustDirectoryForCodex(cwd: string, codexHome?: string): void {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* fall back to cwd */ }

  const configPath = codexConfigPath(codexHome);
  let raw = '';
  try { raw = fs.readFileSync(configPath, 'utf-8'); }
  catch {
    // Codex hasn't been configured yet. Don't create the file
    // ourselves — `codex login` / `codex` will write it on first run
    // and we'll add our trust marker the next time the user spawns a
    // session in this directory.
    return;
  }

  // Detect an existing trusted entry. The TOML key is a quoted
  // basic-string, so the realpath must be matched literally inside
  // double-quotes. We tolerate any whitespace between the header and
  // the `trust_level = "trusted"` line so manual edits don't trip the
  // detection.
  const headerEsc = escapeForRegex(`[projects."${real}"]`);
  const trustedRe = new RegExp(
    headerEsc + '[\\s\\S]*?trust_level\\s*=\\s*"trusted"',
    'm',
  );
  if (trustedRe.test(raw)) return;

  // No matching entry — append a fresh block at the end. We always
  // start with a blank line so we don't accidentally fuse onto a
  // previous table.
  const sep = raw.endsWith('\n') ? '\n' : '\n\n';
  const block =
    sep +
    `[projects."${real.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]\n` +
    `trust_level = "trusted"\n`;

  try {
    const tmp = configPath + '.baton.tmp';
    fs.writeFileSync(tmp, raw + block);
    fs.renameSync(tmp, configPath);
  } catch {
    // best-effort
  }
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
