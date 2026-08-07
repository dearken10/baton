/**
 * Maestro prompt overrides.
 *
 * The option4 orchestrator (per-session-tick.mjs) fires three prompts —
 * next-action (phase 1), outstanding-tasks (phase 2), and phase3-from-
 * docs (phase 3). Each ships as a default markdown file in the repo
 * (`poc/maestro/option4-per-session-clone/prompts/*.md`) that any tick
 * uses out of the box.
 *
 * Settings → Maestro lets the user edit those prompts. This module is
 * the persistence + resolution layer:
 *
 *   read: <BATON_HOME>/maestro/prompts/<slug>.md → repo default file
 *   write: an empty body deletes the override and reverts to the
 *          default; any non-empty body writes the override file
 *
 * Per-instance placement means each BATON_HOME gets its own prompt
 * overrides — matches how the rest of Maestro's state is isolated (see
 * bootstrap-or-tick.sh's STATE_DIR).
 *
 * The tick script reads the same paths at run time (see
 * per-session-tick.mjs `PHASE{1,2,3}_PROMPT`), so a save takes effect
 * on the next tick without a restart.
 */

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { batonHome } from '../paths.js';

/** The three prompts the orchestrator can fire. Keys are stable strings
 *  used both as filenames (<slug>.md) and as the API shape's keys. */
const PROMPT_SLUGS = ['next-action', 'outstanding-tasks', 'phase3-from-docs'] as const;
type PromptSlug = (typeof PROMPT_SLUGS)[number];

/** Repo-default prompt files (checked in). Resolved via the Electron
 *  app path — same trick maestroState.ts uses for the daemon scripts. */
function defaultPromptPath(slug: PromptSlug): string {
  const repoRoot = join(app.getAppPath(), '..');
  return join(repoRoot, 'poc', 'maestro', 'option4-per-session-clone', 'prompts', `${slug}.md`);
}

/** Per-instance override dir. Created lazily when the user saves.
 *  Must match `per-session-tick.mjs`'s prompt-lookup path. */
function overrideDir(): string {
  return join(batonHome(), 'maestro', 'prompts');
}
function overridePath(slug: PromptSlug): string {
  return join(overrideDir(), `${slug}.md`);
}

function readSafe(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  } catch { return null; }
}

export interface MaestroPromptBundle {
  /** Currently-effective text for each prompt (override if present,
   *  otherwise the default). This is what the tick script will use. */
  nextAction: string;
  outstandingTasks: string;
  phase3FromDocs: string;
  /** The repo-shipped defaults, so the UI can show a "Reset to
   *  default" affordance without a second round-trip. */
  defaults: {
    nextAction: string;
    outstandingTasks: string;
    phase3FromDocs: string;
  };
  /** Per-prompt override flags — true iff the user has saved a
   *  non-default body. Drives a "custom" badge in the UI. */
  overridden: {
    nextAction: boolean;
    outstandingTasks: boolean;
    phase3FromDocs: boolean;
  };
}

function readOne(slug: PromptSlug): { effective: string; default_: string; overridden: boolean } {
  const default_ = readSafe(defaultPromptPath(slug)) ?? '';
  const override = readSafe(overridePath(slug));
  return {
    effective: override ?? default_,
    default_,
    overridden: override !== null,
  };
}

export function getMaestroPrompts(): MaestroPromptBundle {
  const p1 = readOne('next-action');
  const p2 = readOne('outstanding-tasks');
  const p3 = readOne('phase3-from-docs');
  return {
    nextAction:       p1.effective,
    outstandingTasks: p2.effective,
    phase3FromDocs:   p3.effective,
    defaults: {
      nextAction:       p1.default_,
      outstandingTasks: p2.default_,
      phase3FromDocs:   p3.default_,
    },
    overridden: {
      nextAction:       p1.overridden,
      outstandingTasks: p2.overridden,
      phase3FromDocs:   p3.overridden,
    },
  };
}

/** Write a single prompt. Empty body deletes the override (reverts to
 *  default). Non-empty body writes to `<BATON_HOME>/maestro/prompts/`. */
function writeOne(slug: PromptSlug, body: string): void {
  const path = overridePath(slug);
  if (body.length === 0) {
    // Remove the override file (falls back to repo default on next read).
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
    return;
  }
  mkdirSync(overrideDir(), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

export interface MaestroPromptWrite {
  nextAction: string;
  outstandingTasks: string;
  phase3FromDocs: string;
}

export function setMaestroPrompts(next: MaestroPromptWrite): MaestroPromptBundle {
  writeOne('next-action',       next.nextAction);
  writeOne('outstanding-tasks', next.outstandingTasks);
  writeOne('phase3-from-docs',  next.phase3FromDocs);
  return getMaestroPrompts();
}
