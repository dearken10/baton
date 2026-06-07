/**
 * Walk every .jsonl under ~/.claude/projects/ and fold their token
 * usage into `token_usage_events` so the plan-usage bars (PRD F11.3)
 * include sessions the user ran OUTSIDE code24 — i.e. plain `claude`
 * in another terminal — matching Anthropic's own metering as closely
 * as we can without a server-side endpoint.
 *
 * Dedup:
 *   - Each transcript file has a row in `transcript_scan_state` that
 *     remembers how many lines we've already processed. We skip those
 *     on every re-scan.
 *   - Files whose stem (== Claude's internal session id) matches one
 *     of OUR session rows are skipped entirely — the in-app token
 *     bookkeeping already covers them, so re-counting via the scanner
 *     would double everything.
 *
 * Performance: typical .jsonl files are small (a few hundred lines at
 * most). A full first-time scan reads everything once; subsequent
 * scans only touch files whose size has grown. We run on boot, every
 * 90 s while the app is open, and just-in-time when the renderer calls
 * `usage.getStats` so the bars show current numbers without a wait.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDatabase } from '../database/index.js';

interface ScanState {
  file_path: string;
  lines_processed: number;
}

interface JsonlLine {
  timestamp?: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

const TRANSCRIPTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

let runningPromise: Promise<void> | null = null;
let lastFullRunAt = 0;

/**
 * Scan all transcripts and insert new usage events. Re-entrant: only
 * one scan runs at a time; concurrent callers wait on the same
 * promise. Safe to call frequently — work is incremental.
 */
export function scanTranscripts(): Promise<void> {
  if (runningPromise) return runningPromise;
  runningPromise = (async () => {
    try {
      await scanOnce();
      lastFullRunAt = Date.now();
    } finally {
      runningPromise = null;
    }
  })();
  return runningPromise;
}

/** Returns the wall-clock ms of the last successful full scan, or 0. */
export function lastScanAt(): number { return lastFullRunAt; }

async function scanOnce(): Promise<void> {
  // Files we own are tracked internally — skip to avoid double-count.
  const knownClaudeIds = new Set<string>(
    (getDatabase()
      .prepare('SELECT DISTINCT claude_session_id FROM sessions WHERE claude_session_id IS NOT NULL')
      .all() as { claude_session_id: string }[]).map((r) => r.claude_session_id)
  );

  let projectDirs: string[];
  try {
    projectDirs = (await fsp.readdir(TRANSCRIPTS_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(TRANSCRIPTS_ROOT, d.name));
  } catch {
    return; // ~/.claude/projects doesn't exist yet — nothing to do
  }

  const stateMap = new Map<string, ScanState>();
  for (const row of getDatabase()
    .prepare('SELECT file_path, lines_processed FROM transcript_scan_state')
    .all() as ScanState[]) {
    stateMap.set(row.file_path, row);
  }

  const insertEvent = getDatabase().prepare(
    `INSERT INTO token_usage_events (session_id, ts, tokens_in, tokens_out)
     VALUES (?, ?, ?, ?)`
  );
  const upsertState = getDatabase().prepare(
    `INSERT INTO transcript_scan_state (file_path, lines_processed, last_scan_at)
     VALUES (?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       lines_processed = excluded.lines_processed,
       last_scan_at = excluded.last_scan_at`
  );

  for (const dir of projectDirs) {
    let files: string[];
    try {
      files = (await fsp.readdir(dir))
        .filter((n) => n.endsWith('.jsonl'))
        .map((n) => path.join(dir, n));
    } catch { continue; }

    for (const file of files) {
      const stem = path.basename(file, '.jsonl');
      if (knownClaudeIds.has(stem)) continue;

      let stat: fs.Stats;
      try { stat = await fsp.stat(file); } catch { continue; }

      const prior = stateMap.get(file);
      const processed = prior?.lines_processed ?? 0;

      // Cheap early-out: if we processed everything and the file hasn't
      // grown since (≈ no new bytes), skip. We compare against a rough
      // proxy — line count — since we don't track size. False positives
      // would just mean we redo a quick re-scan; harmless.
      let content: string;
      try { content = await fsp.readFile(file, 'utf-8'); }
      catch { continue; }
      const lines = content.split('\n');
      // Last element is usually "" because the file ends with \n.
      const totalLines = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
      if (totalLines <= processed) continue;

      // Process the new lines.
      let inserted = 0;
      for (let i = processed; i < totalLines; i++) {
        const line = lines[i];
        if (!line) continue;
        let obj: JsonlLine;
        try { obj = JSON.parse(line) as JsonlLine; } catch { continue; }
        const u = obj.message?.usage;
        if (!u) continue;
        // Matches transcriptReader: exclude cache reads (they don't
        // count toward plan limits at 1:1) but include cache writes.
        const tokensIn =
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0);
        const tokensOut = u.output_tokens ?? 0;
        if (tokensIn === 0 && tokensOut === 0) continue;
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
        const eventTs = Number.isFinite(ts) ? ts : stat.mtimeMs;
        try {
          insertEvent.run(`ext:${stem}`, eventTs, tokensIn, tokensOut);
          inserted++;
        } catch { /* keep going */ }
      }

      try {
        upsertState.run(file, totalLines, Date.now());
      } catch { /* best-effort */ }

      void inserted; // available for telemetry if we want it later
    }
  }
}
