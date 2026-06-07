/**
 * Read Claude's transcript .jsonl and sum token usage.
 *
 * Each assistant turn writes a JSON line with shape
 *   { message: { role: 'assistant', usage: { ... } }, ... }
 * where `usage` is an Anthropic API usage object. We treat:
 *   input_tokens                 — fresh prompt tokens
 *   cache_creation_input_tokens  — tokens written to the prompt cache
 *   cache_read_input_tokens      — tokens served from cache (cheap)
 *   output_tokens                — Claude's response
 * Total "tokens_in" = input + cache_creation + cache_read. We don't
 * compute dollar cost here — that needs a per-model rate table and
 * lives downstream (PRD F11.2/F11.3, deferred).
 */

import * as fs from 'node:fs';

export interface TranscriptUsageSummary {
  tokensIn: number;
  tokensOut: number;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function readTranscriptUsage(transcriptPath: string): TranscriptUsageSummary {
  const empty: TranscriptUsageSummary = { tokensIn: 0, tokensOut: 0 };
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return empty;
  }
  let tokensIn = 0;
  let tokensOut = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj: { message?: { usage?: Usage } };
    try { obj = JSON.parse(line) as typeof obj; } catch { continue; }
    const u = obj.message?.usage;
    if (!u) continue;
    // Anthropic's plan limits don't count cache READS at 1:1 — those
    // are effectively free re-reads of a cached prefix. We count fresh
    // input + cache CREATION (which IS billed). This matches the
    // intuition behind the bar in the titlebar: "real new tokens".
    tokensIn +=
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    tokensOut += u.output_tokens ?? 0;
  }
  return { tokensIn, tokensOut };
}
