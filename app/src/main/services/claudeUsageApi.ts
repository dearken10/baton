/**
 * Read the user's actual plan utilization from the Anthropic-side
 * OAuth usage endpoint that Claude Code itself uses. This is the
 * authoritative number — same data Nimbalyst surfaces — and replaces
 * the locally-aggregated transcript scan we were doing before.
 *
 * Endpoint + headers reverse-engineered from Nimbalyst's bundle:
 *   GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <claude-code OAuth token>
 *   anthropic-beta: oauth-2025-04-20
 *   User-Agent: claude-code/<version>
 *
 * Token lookup order (Claude Code stores it in one of two places):
 *   1. macOS Keychain entries "Claude Code-credentials" / "Claude Code"
 *      — JSON value with claudeAiOauth.accessToken.
 *   2. Fallback file ~/.claude/.credentials.json with the same shape.
 *
 * Response shape (verified against the API):
 *   { five_hour: { utilization, resets_at },
 *     seven_day: { utilization, resets_at },
 *     seven_day_opus?: { utilization, resets_at } }
 *   `utilization` is a PERCENT on a 0..100 scale (5.0 = 5 %, not 500 %),
 *   `resets_at` is ISO-8601.
 *
 * Caching: 5-minute in-process cache so a tight renderer poll loop
 * doesn't hammer Anthropic. Honoured by `getUsage({ force })`.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const CACHE_TTL_MS = 5 * 60 * 1000;
const KEYCHAIN_SERVICES = ['Claude Code-credentials', 'Claude Code'];

export interface UsageWindow {
  /** 0..1 = % of plan used. Can exceed 1 if you've gone over. */
  utilization: number;
  /** ISO-8601 string. Null when the API doesn't have a reset time. */
  resetsAt: string | null;
}

export interface UsageResponse {
  fiveH: UsageWindow;
  sevenD: UsageWindow;
  /** Opus-specific 7d window — only some plans return this. */
  sevenDOpus: UsageWindow | null;
  /** Wall-clock ms when this data was fetched. */
  lastUpdated: number;
  /** Human-readable error when fetch failed; null on success. */
  error: string | null;
}

interface KeychainCredentials { claudeAiOauth?: { accessToken?: string } }
interface RawApiResponse {
  five_hour?: { utilization?: number; resets_at?: string | null };
  seven_day?: { utilization?: number; resets_at?: string | null };
  seven_day_opus?: { utilization?: number; resets_at?: string | null };
}

const EMPTY_WINDOW: UsageWindow = { utilization: 0, resetsAt: null };

/** Per-token-source cache. Keyed so the global login, a pasted-token
 *  login, and each browser login are cached independently. */
const caches = new Map<string, UsageResponse>();
const inflights = new Map<string, Promise<UsageResponse>>();

function getAccessTokenFromKeychain(): string | null {
  if (process.platform !== 'darwin') return null;
  for (const service of KEYCHAIN_SERVICES) {
    try {
      const out = execSync(
        `security find-generic-password -s ${JSON.stringify(service)} -w`,
        { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();
      const creds = JSON.parse(out) as KeychainCredentials;
      const token = creds.claudeAiOauth?.accessToken;
      if (token) return token;
    } catch { /* try next */ }
  }
  return null;
}

function readCredentialsFile(p: string): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    const creds = JSON.parse(fs.readFileSync(p, 'utf8')) as KeychainCredentials;
    return creds.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function getAccessTokenFromCredentialsFile(): string | null {
  return readCredentialsFile(path.join(os.homedir(), '.claude', '.credentials.json'));
}

function getAccessToken(): string | null {
  return getAccessTokenFromKeychain() ?? getAccessTokenFromCredentialsFile();
}

/** Access token for a browser login stored as a file in its own config
 *  dir. Claude Code writes `.credentials.json` there on Linux/Windows when
 *  CLAUDE_CONFIG_DIR is set. On macOS it uses the Keychain instead, so this
 *  returns null there — see getAccessTokenFromKeychainForDir. */
function getAccessTokenFromDir(dir: string): string | null {
  return readCredentialsFile(path.join(dir, '.credentials.json'));
}

/** The macOS Keychain service name Claude Code uses for a login's OAuth
 *  credentials. The default config dir (`~/.claude`) uses the bare
 *  "Claude Code-credentials"; a custom CLAUDE_CONFIG_DIR is scoped by
 *  appending "-<first 8 hex of sha256(configDir)>" so multiple accounts
 *  don't collide. Mirrors Claude Code's own derivation (reverse-engineered
 *  from the 2.1.x bundle: service = `Claude Code-credentials-${sha256(NFC
 *  configDir).slice(0,8)}`); the account field is $USER. Version-dependent
 *  — if a Claude Code update changes the scheme this silently returns no
 *  token and the meter falls back to the "no credentials" state. */
function keychainServiceForConfigDir(configDir: string): string {
  const norm = configDir.normalize('NFC');
  const hash8 = createHash('sha256').update(norm).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hash8}`;
}

/** Read a browser login's OAuth token from the macOS Keychain. On macOS
 *  Claude stores it there (not in <configDir>/.credentials.json), under a
 *  config-dir-scoped service name. Non-macOS / not found → null. */
function getAccessTokenFromKeychainForDir(dir: string): string | null {
  if (process.platform !== 'darwin') return null;
  const service = keychainServiceForConfigDir(dir);
  try {
    const out = execSync(
      `security find-generic-password -s ${JSON.stringify(service)} -w`,
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    const creds = JSON.parse(out) as KeychainCredentials;
    return creds.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function getClaudeCodeVersion(): string {
  // Mirror Nimbalyst's UA tag. We resolve the user's installed Claude
  // Code SDK manifest; if we can't find it, fall back to "unknown".
  try {
    const sdkDir = path.dirname(
      require.resolve('@anthropic-ai/claude-agent-sdk', {
        paths: [process.cwd(), os.homedir()],
      })
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(sdkDir, 'manifest.json'), 'utf8')
    ) as { version?: string };
    return manifest.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function fetchOnce(token: string | null): Promise<UsageResponse> {
  if (!token) {
    return {
      fiveH: EMPTY_WINDOW,
      sevenD: EMPTY_WINDOW,
      sevenDOpus: null,
      lastUpdated: Date.now(),
      error:
        process.platform === 'darwin'
          ? 'No Claude Code credentials found in macOS Keychain or ~/.claude/.credentials.json.'
          : 'No Claude Code credentials found in ~/.claude/.credentials.json.',
    };
  }

  let res: Response;
  try {
    res = await fetch(USAGE_API_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${getClaudeCodeVersion()}`,
      },
    });
  } catch (err) {
    return {
      fiveH: EMPTY_WINDOW,
      sevenD: EMPTY_WINDOW,
      sevenDOpus: null,
      lastUpdated: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 600); } catch { /* ignore */ }
    return {
      fiveH: EMPTY_WINDOW,
      sevenD: EMPTY_WINDOW,
      sevenDOpus: null,
      lastUpdated: Date.now(),
      error:
        res.status === 401 ? 'Authentication expired — re-login to Claude Code.'
        : res.status === 403 ? 'Usage API forbidden (403) for this account.'
        : res.status === 429 ? 'Rate limited (429) — retrying later.'
        : `Anthropic API ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`,
    };
  }

  const data = (await res.json()) as RawApiResponse;
  return {
    fiveH: {
      utilization: data.five_hour?.utilization ?? 0,
      resetsAt: data.five_hour?.resets_at ?? null,
    },
    sevenD: {
      utilization: data.seven_day?.utilization ?? 0,
      resetsAt: data.seven_day?.resets_at ?? null,
    },
    sevenDOpus: data.seven_day_opus
      ? {
          utilization: data.seven_day_opus.utilization ?? 0,
          resetsAt: data.seven_day_opus.resets_at ?? null,
        }
      : null,
    lastUpdated: Date.now(),
    error: null,
  };
}

/**
 * Fetch usage for one token source, caching per `key`. `resolveToken`
 * is only called on a cache miss so we don't hit the keychain / disk on
 * every poll. Returns a fresh value when the cache is older than
 * CACHE_TTL_MS (or never warmed); reuses the cached value otherwise.
 */
async function getUsageKeyed(
  key: string,
  resolveToken: () => string | null,
  opts: { force?: boolean } = {}
): Promise<UsageResponse> {
  const cached = caches.get(key);
  if (!opts.force && cached && Date.now() - cached.lastUpdated < CACHE_TTL_MS) {
    return cached;
  }
  const existing = inflights.get(key);
  if (existing) return existing;
  const p = fetchOnce(resolveToken())
    .then((res) => { caches.set(key, res); return res; })
    .finally(() => { inflights.delete(key); });
  inflights.set(key, p);
  return p;
}

/**
 * Fetch the machine's default (global) plan utilization. Pass
 * { force: true } to bypass the cache.
 */
export async function getUsage(opts: { force?: boolean } = {}): Promise<UsageResponse> {
  return getUsageKeyed('global', getAccessToken, opts);
}

/** Fetch usage for a login whose OAuth token we hold directly (a pasted
 *  `token` login). */
export async function getUsageForToken(
  key: string,
  token: string | null,
  opts: { force?: boolean } = {}
): Promise<UsageResponse> {
  return getUsageKeyed(key, () => token, opts);
}

/** Fetch usage for a browser login stored in its own config dir. Token
 *  source: the config-dir `.credentials.json` (Linux/Windows), falling
 *  back to the macOS Keychain (where Claude actually stores it on Mac). */
export async function getUsageForConfigDir(
  key: string,
  dir: string,
  opts: { force?: boolean } = {}
): Promise<UsageResponse> {
  return getUsageKeyed(
    key,
    () => getAccessTokenFromDir(dir) ?? getAccessTokenFromKeychainForDir(dir),
    opts
  );
}
