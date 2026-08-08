/**
 * Maestro prompt override — just the `goal` prompt now that the tick
 * daemon has been removed. It drives the option5 PM proposer that
 * feeds the MaestroSuggestionCard (variant A, inline dock).
 *
 * Persistence + resolution:
 *   read: <BATON_HOME>/maestro/prompts/goal.md → repo default file
 *   write: an empty body deletes the override and reverts to the
 *          default; any non-empty body writes the override file
 *
 * Per-instance placement means each BATON_HOME gets its own prompt
 * override — matches how the rest of Maestro state is isolated.
 *
 * The PM script (pm-propose.mjs) is invoked via
 * `resolveMaestroPromptPath('goal')` so a save takes effect on the
 * next fire without a restart.
 */

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { batonHome } from '../paths.js';

const GOAL_DIR = 'poc/maestro/option5-product-manager/prompts';
const GOAL_FILENAME = 'goal.md';

function defaultPromptPath(): string {
  const repoRoot = join(app.getAppPath(), '..');
  return join(repoRoot, GOAL_DIR, GOAL_FILENAME);
}

function overrideDir(): string {
  return join(batonHome(), 'maestro', 'prompts');
}
function overridePath(): string {
  return join(overrideDir(), GOAL_FILENAME);
}

function readSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch { return null; }
}

export interface MaestroPromptBundle {
  /** Currently-effective goal.md body (override if present, else the
   *  repo default). */
  goal: string;
  /** The repo-shipped default so the UI can render "Reset to default"
   *  without a second round-trip. */
  defaults: { goal: string };
  /** True iff the user has saved a non-empty override. Drives the
   *  "customized" badge in Settings → Maestro. */
  overridden: { goal: boolean };
}

export function getMaestroPrompts(): MaestroPromptBundle {
  const default_ = readSafe(defaultPromptPath()) ?? '';
  const override = readSafe(overridePath());
  return {
    goal:       override ?? default_,
    defaults:   { goal: default_ },
    overridden: { goal: override !== null },
  };
}

/** Absolute path the PM script should be pointed at — override first,
 *  else the repo default. Returns null if neither exists (only happens
 *  if someone deleted the checked-in file). */
export function resolveMaestroPromptPath(slug: 'goal'): string | null {
  void slug; // reserved for future slugs
  const override = overridePath();
  if (existsSync(override)) return override;
  const dflt = defaultPromptPath();
  if (existsSync(dflt)) return dflt;
  return null;
}

export interface MaestroPromptWrite {
  goal: string;
}

export function setMaestroPrompts(next: MaestroPromptWrite): MaestroPromptBundle {
  const path = overridePath();
  if (next.goal.length === 0) {
    // Empty body → delete override, fall back to the repo default.
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
  } else {
    mkdirSync(overrideDir(), { recursive: true });
    writeFileSync(path, next.goal, 'utf8');
  }
  return getMaestroPrompts();
}
