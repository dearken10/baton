/**
 * Per-login usage aggregation for the titlebar meters.
 *
 * The renderer shows one plan-usage chip per login session. This module
 * turns the list of login sessions into one usage reading each, using
 * the right source for the session's kind:
 *
 *   Claude  global  → machine keychain / ~/.claude/.credentials.json
 *           token   → the pasted OAuth token, queried directly
 *           browser → <configDir>/.credentials.json (best-effort)
 *           custom  → omitted (no Anthropic OAuth usage endpoint)
 *   Codex   global  → ~/.codex/sessions rollout logs
 *           browser → <configDir>/sessions rollout logs
 *           token / custom → omitted (no isolated rollout logs)
 *
 * Each source keeps its own cache (keyed by `login:<id>`), so polling
 * this once a minute is cheap.
 */

import type { UsageListItem } from '../../shared/ipc.js';
import {
  listLoginSessions,
  getLoginSecret,
  loginConfigDir,
} from './loginSessions.js';
import {
  getUsage,
  getUsageForToken,
  getUsageForConfigDir,
} from './claudeUsageApi.js';
import { getCodexUsage, getCodexUsageForHome } from './codexUsageApi.js';

export async function buildUsageList(): Promise<UsageListItem[]> {
  const items: UsageListItem[] = [];

  for (const s of listLoginSessions()) {
    const key = `login:${s.id}`;

    if (s.agent === 'claude-code') {
      let stats: UsageListItem['stats'] | null = null;
      if (s.kind === 'global') {
        stats = await getUsage();
      } else if (s.kind === 'token') {
        stats = await getUsageForToken(key, getLoginSecret(s.id));
      } else if (s.kind === 'browser') {
        const dir = loginConfigDir(s.id);
        if (dir) stats = await getUsageForConfigDir(key, dir);
      }
      // 'custom' → no measurable usage; skip.
      if (stats) {
        items.push({ loginSessionId: s.id, name: s.name, agent: s.agent, stats });
      }
    } else {
      // codex
      let stats: UsageListItem['stats'] | null = null;
      if (s.kind === 'global') {
        stats = getCodexUsage();
      } else if (s.kind === 'browser') {
        const dir = loginConfigDir(s.id);
        if (dir) stats = getCodexUsageForHome(key, dir);
      }
      // 'token' / 'custom' → no isolated rollout logs; skip.
      if (stats) {
        items.push({ loginSessionId: s.id, name: s.name, agent: s.agent, stats });
      }
    }
  }

  return items;
}
