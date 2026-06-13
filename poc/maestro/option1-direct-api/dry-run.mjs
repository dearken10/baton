#!/usr/bin/env node
// poc/maestro/dry-run.mjs
//
// End-to-end Maestro tick (no execution).
// Pipeline:  inventory.mjs → planner.mjs → human-readable report
//
// Usage:
//   USAGE_5H=0.06 USAGE_7D=0.06 ANTHROPIC_API_KEY=... \
//     node poc/maestro/dry-run.mjs
//
// Outputs:
//   - poc/maestro/last-inventory.json   (input the planner saw)
//   - poc/maestro/last-plan.json        (raw planner output)
//   - stdout: human-readable summary
//
// NOTHING IS EXECUTED. This is propose-only by construction.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function hasCredentials() {
  if (process.env.ANTHROPIC_API_KEY) return 'env (ANTHROPIC_API_KEY)';
  if (process.platform === 'darwin') {
    for (const svc of ['Claude Code-credentials', 'Claude Code']) {
      try {
        const out = execSync(
          `security find-generic-password -s ${JSON.stringify(svc)} -w`,
          { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (JSON.parse(out)?.claudeAiOauth?.accessToken) return `keychain (${svc})`;
      } catch { /* try next */ }
    }
  }
  const p = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(p)) {
    try {
      const c = JSON.parse(readFileSync(p, 'utf8'));
      if (c?.claudeAiOauth?.accessToken) return '~/.claude/.credentials.json';
    } catch { /* ignore */ }
  }
  return null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = __dirname;
mkdirSync(OUT_DIR, { recursive: true });

function step(label, fn) {
  const t0 = Date.now();
  process.stderr.write(`▸ ${label}... `);
  try {
    const r = fn();
    process.stderr.write(`ok (${Date.now() - t0} ms)\n`);
    return r;
  } catch (e) {
    process.stderr.write(`FAIL: ${e.message}\n`);
    throw e;
  }
}

// CLI flags
const args = process.argv.slice(2);
const includeActive = args.includes('--include-active');

const rawInventory = step('collect inventory', () =>
  execFileSync('node', [join(__dirname, 'inventory.mjs')], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
);

// F15.1 runtime gate: drop running claude-code / codex sessions
// before calling the planner. The planner is mode-unaware and treats
// any such session as user_active; this filter says "the human isn't
// at the keyboard for *that* session" by removing it from the
// inventory the planner sees. A running shell stays — it's a dev
// server, not user presence.
//
// Maestro's own master-mind session (session_kind='maestro') is
// exempt from the "user active" treatment but is also always dropped
// from the candidate set — Maestro can never resume/initiate itself.
//
// --include-active disables the filter (useful for debugging the
// planner's user_active behavior).
const invObj = JSON.parse(rawInventory);
const before = invObj.sessions.length;
let droppedMaestro = 0;
let droppedUserActive = 0;
if (!includeActive) {
  invObj.sessions = invObj.sessions.filter((s) => {
    if (s.session_kind === 'maestro') { droppedMaestro++; return false; }
    if (
      s.status === 'running' &&
      (s.backend === 'claude-code' || s.backend === 'codex')
    ) {
      droppedUserActive++;
      return false;
    }
    return true;
  });
}
const filtered = before - invObj.sessions.length;
invObj.runtime_filter = {
  applied: !includeActive,
  dropped_user_active: droppedUserActive,
  dropped_maestro: droppedMaestro
};
const inventory = JSON.stringify(invObj);
writeFileSync(join(OUT_DIR, 'last-inventory.json'), inventory);
process.stderr.write(
  `▸ gate: dropped ${droppedUserActive} user-active + ${droppedMaestro} maestro ` +
    `(${invObj.sessions.length} candidates remain)\n`
);

const creds = hasCredentials();
if (!creds) {
  console.error('\n⚠️  No credentials found — stopping at inventory.');
  console.error('   Set ANTHROPIC_API_KEY, or log in to Claude Code.');
  console.error('   Wrote', join(OUT_DIR, 'last-inventory.json'));
  process.exit(0);
}
process.stderr.write(`▸ auth: ${creds}\n`);

const planRaw = step('call planner', () =>
  execFileSync('node', [join(__dirname, 'planner.mjs')], {
    encoding: 'utf8',
    input: inventory,
    stdio: ['pipe', 'pipe', 'inherit']
  })
);
writeFileSync(join(OUT_DIR, 'last-plan.json'), planRaw);

const plan = JSON.parse(planRaw);
const inv = JSON.parse(inventory);

console.log('');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Maestro PoC tick   ${plan.tick_at ?? inv.now}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(
  `  usage: 5h=${(inv.usage_pct_5h * 100).toFixed(0)}%   ` +
    `7d=${(inv.usage_pct_7d * 100).toFixed(0)}%   ` +
    `live=${inv.active_session_count}   ` +
    `candidates=${inv.sessions.length}   ` +
    `dropped_active=${inv.runtime_filter?.dropped_user_active ?? 0}   ` +
    `backlogs=${Object.keys(inv.backlogs).length}`
);
if (plan.skip_reason) {
  console.log(`  SKIP: ${plan.skip_reason}`);
}
if (plan.reasoning) {
  console.log('');
  const wrapped = plan.reasoning.match(/.{1,72}(\s|$)/g) ?? [plan.reasoning];
  for (const line of wrapped) console.log(`  ⓘ ${line.trim()}`);
}
console.log('');
const actions = plan.actions ?? [];
if (actions.length === 0) {
  console.log('  No actions proposed this tick.');
} else {
  for (const [i, a] of actions.entries()) {
    const target =
      a.kind === 'initiate'
        ? `project ${a.target_project_id?.slice(0, 8) ?? '?'}`
        : `session ${a.target_session_id?.slice(0, 8) ?? '?'}`;
    console.log(
      `  ${i + 1}. [${a.kind.toUpperCase()}] ${target}  ` +
        `conf=${a.confidence?.toFixed?.(2) ?? '?'}`
    );
    console.log(`     rationale: ${a.rationale}`);
    if (a.prompt) {
      const p = a.prompt.replace(/\s+/g, ' ').slice(0, 160);
      console.log(`     prompt:    "${p}${a.prompt.length > 160 ? '…' : ''}"`);
    }
    if (a.backlog_item) {
      console.log(`     backlog:   ${a.backlog_item}`);
    }
    if (Array.isArray(a.assumptions_made) && a.assumptions_made.length) {
      console.log(`     assumptions (${a.assumptions_made.length}):`);
      for (const [j, as] of a.assumptions_made.entries()) {
        console.log(`       ${j + 1}. Q: ${as.question}`);
        console.log(`          A: ${as.assumed_answer}`);
        if (as.why) console.log(`          ∵ ${as.why}`);
        if (as.if_wrong) console.log(`          ✗ ${as.if_wrong}`);
      }
    }
    console.log(`     revert:    ${a.reversibility_note}`);
    console.log('');
  }
}
console.log(
  '  ↳ Nothing executed. Review last-plan.json before any action.'
);
console.log('');
