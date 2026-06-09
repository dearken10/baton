/**
 * IPC contract between main and renderer.
 *
 * Per PRD F10.1: single internal IPC channel; every verb has a Zod
 * schema; CI compares snapshots, fails on drift. This file is the
 * source of truth — both main handlers and renderer callers import
 * from here.
 *
 * Per PRD F10.2: `pty.data` lives on its own channel (`Channels.ptyData`)
 * so high-rate terminal data cannot starve control verbs. Control
 * verbs run on `Channels.control`.
 */

import { z } from 'zod';

/* ────────────────────────────────────────────────────────────────
 * Common primitives
 * ──────────────────────────────────────────────────────────────── */

export const SessionId = z.string().uuid();
export type SessionId = z.infer<typeof SessionId>;

export const ProjectId = z.string().min(1);
export type ProjectId = z.infer<typeof ProjectId>;

export const SessionStatus = z.enum([
  'running',
  'needs-input',
  'idle',
  'done',
  'errored',
  'paused',
  'disconnected', // Remote SSH only — F14.8
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const AgentBackendId = z.enum(['claude-code', 'codex', 'mock', 'shell']);
export type AgentBackendId = z.infer<typeof AgentBackendId>;

export const ConnectionKind = z.enum(['local', 'ssh']);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

export const SshAuthMethod = z.enum(['key', 'agent', 'password']);
export type SshAuthMethod = z.infer<typeof SshAuthMethod>;

export const ClaudeCredsMode = z.enum(['remote', 'forward']);
export type ClaudeCredsMode = z.infer<typeof ClaudeCredsMode>;

/** Test-connection result codes. `success` = SSH up + daemon probe OK;
 *  `daemon_missing` = SSH ok but `node`/`git` not available on remote;
 *  other codes are pre-handshake failures. Stage 1 only emits
 *  `success` / `auth_failed` / `unreachable` / `timeout` / `error` —
 *  `daemon_missing` is reserved for when the F14 daemon probe lands. */
export const ConnectionProbeStatus = z.enum([
  'success',
  'auth_failed',
  'unreachable',
  'timeout',
  'daemon_missing',
  'error',
]);
export type ConnectionProbeStatus = z.infer<typeof ConnectionProbeStatus>;

/** A saved connection target. The built-in row with id="local" always
 *  exists and represents this Mac; it can't be renamed or deleted. */
export const ConnectionProfile = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: ConnectionKind,
  // SSH-only fields. Null for kind="local".
  host: z.string().nullable(),
  user: z.string().nullable(),
  port: z.number().int().positive().nullable(),
  authMethod: SshAuthMethod.nullable(),
  /** Absolute path to the private key file on the Mac. Only meaningful
   *  when authMethod="key". Kept off-the-wire — we just need to point
   *  ssh at it via -i. */
  authKeyPath: z.string().nullable(),
  /** "remote" = use the remote's existing ~/.claude/credentials.
   *  "forward" = pass an env-forwarded token from the Mac per session. */
  claudeCredsMode: ClaudeCredsMode.nullable(),
  /** Last test-connection result, for the dropdown's status badge.
   *  Null on a freshly created profile that hasn't been probed yet. */
  lastStatus: ConnectionProbeStatus.nullable(),
  /** Wall-clock ms when lastStatus was written. Null when never probed. */
  lastProbedAt: z.number().nullable(),
  createdAt: z.number(),
});
export type ConnectionProfile = z.infer<typeof ConnectionProfile>;

export const Project = z.object({
  id: ProjectId,
  path: z.string(),
  name: z.string(),
  addedAt: z.number(),
  /** Wall-clock ms when the user snoozed this project, or null when
   *  active. Snoozed projects render in the left column's "Snoozed"
   *  view instead of the default "Active" list. */
  snoozedAt: z.number().nullable(),
  /** Which connection profile owns this project's filesystem. "local"
   *  for projects on this Mac (the default); a profile id for remote
   *  projects. */
  connectionId: z.string().min(1),
});
export type Project = z.infer<typeof Project>;

export const Session = z.object({
  id: SessionId,
  projectId: ProjectId,
  backendId: AgentBackendId,
  branch: z.string(),
  worktreePath: z.string(),
  status: SessionStatus,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  lastSummary: z.string().nullable(),
  /** Claude's internal session id (captured from SessionStart hook). */
  claudeSessionId: z.string().nullable(),
  /** True when this session was spawned with --dangerously-skip-
   *  permissions, i.e. Claude auto-approves every tool use. Persisted
   *  per row so toggling survives respawn/resume. */
  skipPermissions: z.boolean(),
  /** Wall-clock ms when the user snoozed this session, or null when
   *  active. While snoozed, the renderer hides the status chip (like
   *  the default `idle` treatment) so false-positive needs-input
   *  flags don't keep nagging. */
  snoozedAt: z.number().nullable(),
});
export type Session = z.infer<typeof Session>;

/* ────────────────────────────────────────────────────────────────
 * Control-channel verbs (request/response)
 * ──────────────────────────────────────────────────────────────── */

const Empty = z.object({});

const PingResponse = z.object({ ok: z.literal(true), ts: z.number() });
const AppMetaResponse = z.object({
  version: z.string(),
  electron: z.string(),
  node: z.string(),
  platform: z.string(),
});

const ProjectAddRequest = z.object({
  path: z.string().min(1),
  /** Optional display-name override. Defaults to basename(path). */
  name: z.string().trim().min(1).max(120).optional(),
  /** Connection profile id. Defaults to "local" — the built-in row. */
  connectionId: z.string().min(1).optional(),
});
const ProjectAddResponse = z.object({ project: Project });

/** Create a fresh folder at `path` (with `~` expanded to the user's
 *  home), optionally `git init` it, and register it as a project.
 *  Refuses if the target folder already exists (renderer should switch
 *  the user to "Add existing"). The parent of `path` is mkdir-p'd. */
const ProjectCreateRequest = z.object({
  /** Absolute path or `~`-prefixed path of the project folder to
   *  create — e.g. `~/baton/my-project` or `/Users/x/code/my-project`. */
  path: z.string().trim().min(1),
  initGit: z.boolean().optional(),
  /** Connection profile id. Defaults to "local". For non-local
   *  connections in Stage 1, mkdir/git-init happen lazily on first
   *  use; the project is registered as metadata-only. */
  connectionId: z.string().min(1).optional(),
});
const ProjectCreateResponse = z.object({ project: Project });

/* ─── Connection profile CRUD + probes ─── */

const ConnectionListResponse = z.object({
  profiles: z.array(ConnectionProfile),
});

/** Fields a renderer can supply when creating a new SSH connection. The
 *  built-in `local` profile is seeded once at boot and isn't created
 *  through this verb. */
const ConnectionCreateRequest = z.object({
  name: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1),
  user: z.string().trim().min(1),
  port: z.number().int().positive().default(22),
  authMethod: SshAuthMethod,
  /** Required when authMethod="key". Stored as-is; ssh resolves it. */
  authKeyPath: z.string().trim().min(1).optional(),
  claudeCredsMode: ClaudeCredsMode.default('remote'),
});
const ConnectionCreateResponse = z.object({ profile: ConnectionProfile });

const ConnectionUpdateRequest = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
  host: z.string().trim().min(1).optional(),
  user: z.string().trim().min(1).optional(),
  port: z.number().int().positive().optional(),
  authMethod: SshAuthMethod.optional(),
  authKeyPath: z.string().trim().min(1).nullable().optional(),
  claudeCredsMode: ClaudeCredsMode.optional(),
});
const ConnectionUpdateResponse = z.object({ profile: ConnectionProfile });

const ConnectionDeleteRequest = z.object({ id: z.string().min(1) });
const ConnectionDeleteResponse = z.object({ ok: z.literal(true) });

/** Probe an SSH connection. Always reachable for kind="local". The
 *  result is also persisted to lastStatus/lastProbedAt on the profile
 *  so the dropdown badge survives a relaunch. */
const ConnectionTestRequest = z.object({ id: z.string().min(1) });
const ConnectionTestResponse = z.object({
  status: ConnectionProbeStatus,
  /** Round-trip ms for `success`; null otherwise. */
  rttMs: z.number().int().nonnegative().nullable(),
  /** Human-readable detail surfaced inline in the dialog (e.g. ssh
   *  stderr). Empty string when nothing useful to show. */
  detail: z.string(),
});

/** Probe a path on a connection — runs `test -d <path> && pwd` over
 *  SSH (or stat locally) and returns the resolved absolute path. Used
 *  by AddProjectDialog's Validate button. */
const ConnectionTestPathRequest = z.object({
  connectionId: z.string().min(1),
  /** May include a leading `~/`. */
  path: z.string().trim().min(1),
});
const ConnectionTestPathResponse = z.object({
  ok: z.boolean(),
  /** Resolved absolute path on the target host when ok=true. Empty
   *  string otherwise. */
  resolvedPath: z.string(),
  /** Human-readable failure detail when ok=false. */
  detail: z.string(),
});

/** Force an immediate reconnect of the long-lived SSH master for a
 *  remote profile. Powers the "Reconnect now" button in the disconnect
 *  banner. Local profiles always resolve immediately. */
const ConnectionReconnectRequest = z.object({ id: z.string().min(1) });
const ConnectionReconnectResponse = z.object({ ok: z.literal(true) });

/** List one level of a directory on a connection. Powers the
 *  RemoteFolderPicker at add-project time, before a session exists.
 *  Path may include a leading `~` — resolvedPath echoes back the
 *  absolute path we ended up at so the renderer can show a breadcrumb. */
const ConnectionListDirRequest = z.object({
  connectionId: z.string().min(1),
  /** May be empty or `~` to land at the target's home directory. */
  path: z.string(),
});
const ConnectionListDirEntry = z.object({
  name: z.string(),
  kind: z.union([
    z.literal('file'),
    z.literal('dir'),
    z.literal('symlink'),
    z.literal('other'),
  ]),
});
const ConnectionListDirResponse = z.object({
  /** Absolute path of the directory we actually read. */
  resolvedPath: z.string(),
  /** Listing, sorted dirs first then files, alphabetical. Hidden
   *  entries (leading dot) are kept — the picker dims them. */
  entries: z.array(ConnectionListDirEntry),
  /** Empty string on success; a human-readable error otherwise. */
  error: z.string(),
});

const ProjectListResponse = z.object({ projects: z.array(Project) });
const ProjectPickResponse = z.object({ path: z.string().nullable() });

const ProjectRemoveRequest = z.object({ projectId: ProjectId });
const ProjectRemoveResponse = z.object({ ok: z.literal(true) });

const ProjectReorderRequest = z.object({ orderedIds: z.array(ProjectId).min(1) });
const ProjectReorderResponse = z.object({ ok: z.literal(true) });

const ProjectRenameRequest = z.object({
  projectId: ProjectId,
  newName: z.string().trim().min(1).max(120),
});
const ProjectRenameResponse = z.object({ project: Project });

/** Toggle snoozed/active for a project. Snoozed projects stay in the
 *  DB with their sessions intact — only the left-column view changes. */
const ProjectSetSnoozedRequest = z.object({
  projectId: ProjectId,
  snoozed: z.boolean(),
});
const ProjectSetSnoozedResponse = z.object({ project: Project });

const SessionReorderRequest = z.object({ orderedIds: z.array(SessionId).min(1) });
const SessionReorderResponse = z.object({ ok: z.literal(true) });

const SessionListResponse = z.object({
  sessions: z.array(Session),
  /** Ids that boot auto-resume is about to bring back up. Renderer
   *  flips these to a "Starting…" indicator atomically with loading
   *  the sessions, so the row doesn't briefly flash `done`/`errored`
   *  while we wait for the actual `session.starting` event to arrive
   *  from the slower per-session spawn loop. */
  startingIds: z.array(SessionId),
});

/** Rolling token usage windows for the plan-usage indicator (F11.3).
 *  Returns absolute totals for the last 5h and 7d; the renderer
 *  divides by the user-selected plan limits to compute the percent. */
const UsageGetStatsRequest = z.object({});
/** Authoritative usage data from Anthropic's OAuth usage endpoint —
 *  same source Claude Code itself uses for the in-CLI "approaching
 *  limit" warnings. Replaced the locally-aggregated transcript scan
 *  we used to do. */
const UsageWindow = z.object({
  /** 0..1 = % of plan used in this rolling window. Can exceed 1. */
  utilization: z.number(),
  /** ISO-8601 string. Null when the API can't compute a reset time. */
  resetsAt: z.string().nullable(),
});
const UsageGetStatsResponse = z.object({
  fiveH:  UsageWindow,
  sevenD: UsageWindow,
  /** Opus-specific 7d window (some plans return this). */
  sevenDOpus: UsageWindow.nullable(),
  /** Wall-clock ms when the API was last polled. */
  lastUpdated: z.number(),
  /** Human-readable error when fetch failed (e.g. no token, 401);
   *  null on success. Renderer renders a fallback state when set. */
  error: z.string().nullable(),
});

/** Renderer tells main which session is currently focused in the UI
 *  so the notifier can suppress redundant pop-ups (and so we know
 *  what to mark "read" when the user is already looking). */
const AppSelectedSessionRequest = z.object({
  sessionId: SessionId.nullable(),
});
const AppSelectedSessionResponse = z.object({});
const SessionSpawnRequest = z.object({
  projectId: ProjectId,
  backendId: AgentBackendId.default('claude-code'),
  /** When set, create a fresh git worktree at this branch first and
   *  spawn the agent inside it. When omitted, spawn in the project
   *  root (sessions share a working tree, F2.2 default off). */
  newWorktreeBranch: z.string().optional(),
  /** When set, spawn in this existing worktree directory (must be a
   *  worktree of the given project). Used by "New worktree terminal"
   *  to drop a shell into an existing branch without creating a new
   *  one. Mutually exclusive with `newWorktreeBranch`. */
  existingWorktreePath: z.string().optional(),
  /** When true, launch Claude with --dangerously-skip-permissions.
   *  Defaults to false; the user can flip it later from the middle
   *  column. */
  skipPermissions: z.boolean().optional(),
});
const SessionSpawnResponse = z.object({ session: Session });
const SessionKillRequest = z.object({ sessionId: SessionId });
const SessionKillResponse = z.object({ ok: z.literal(true) });

const SessionResumeRequest = z.object({ sessionId: SessionId });
const SessionResumeResponse = z.object({ session: Session });

/** Flip the session's skipPermissions flag and restart with the new
 *  value (using `--resume` so conversation history survives). */
const SessionToggleYoloRequest = z.object({ sessionId: SessionId });
const SessionToggleYoloResponse = z.object({ session: Session });

/** Start a fresh Claude session inside an existing (ended) session's
 *  cwd, reusing the same baton session id. No `--resume` — the prior
 *  conversation history isn't reloaded. Used when the user wants to
 *  pick a worktree back up without an existing transcript. */
const SessionRespawnRequest = z.object({ sessionId: SessionId });
const SessionRespawnResponse = z.object({ session: Session });

const SessionDeleteRequest = z.object({
  sessionId: SessionId,
  /** Also `git worktree remove` and delete the worktree dir.
   *  Defaults to true when the session was spawned in a worktree. */
  removeWorktree: z.boolean().optional(),
});
const SessionDeleteResponse = z.object({
  ok: z.literal(true),
  worktreeRemoved: z.boolean(),
});

const SessionRenameRequest = z.object({
  sessionId: SessionId,
  newBranchName: z.string().min(1),
});
const SessionRenameResponse = z.object({ session: Session });

/** Toggle per-session snooze. While snoozed, the renderer hides the
 *  status chip so spurious `needs-input` flags don't nag the user. */
const SessionSetSnoozedRequest = z.object({
  sessionId: SessionId,
  snoozed: z.boolean(),
});
const SessionSetSnoozedResponse = z.object({ session: Session });

// ── Worktree readers (right column) ─────────────────────────────
// Recursive node type defined first, then z.lazy with that as the
// generic argument so TypeScript can resolve the recursion.
export interface FileTreeNodeT {
  name: string;
  path: string;
  type: 'file' | 'dir';
  // Explicit `| undefined` so Zod's inferred output type (which always
  // includes undefined for .optional()) matches under
  // exactOptionalPropertyTypes.
  children?: FileTreeNodeT[] | undefined;
  truncated?: boolean | undefined;
}
const FileTreeNode: z.ZodType<FileTreeNodeT> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    type: z.union([z.literal('file'), z.literal('dir')]),
    children: z.array(FileTreeNode).optional(),
    truncated: z.boolean().optional(),
  })
);

const WorktreeFileTreeRequest = z.object({ sessionId: SessionId });
const WorktreeFileTreeResponse = z.object({ root: FileTreeNode });

/** Lazy-load one level of children for a worktree subdir. Used by the
 *  Files panel when the user expands a node whose contents weren't
 *  scanned in the initial fileTree call (depth-cap leaves). */
const WorktreeReadDirRequest = z.object({
  sessionId: SessionId,
  /** Path relative to the worktree root. Empty = root itself. */
  relPath: z.string(),
});
const WorktreeReadDirResponse = z.object({
  children: z.array(FileTreeNode),
  /** True if entries beyond MAX_ENTRIES_PER_DIR were dropped. */
  truncated: z.boolean(),
});

const GitStatusFile = z.object({
  path: z.string(),
  state: z.union([
    z.literal('modified'),
    z.literal('staged'),
    z.literal('untracked'),
    z.literal('deleted'),
    z.literal('conflicted'),
  ]),
});
const WorktreeGitStatusRequest = z.object({ sessionId: SessionId });
const WorktreeGitStatusResponse = z.object({
  branch: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(GitStatusFile),
  dirty: z.boolean(),
});

/** Open a file or dir in the system default application. */
const ShellOpenPathRequest = z.object({ absPath: z.string().min(1) });
const ShellOpenPathResponse = z.object({ ok: z.boolean() });

/** Launch the platform's default terminal app with cwd = absPath.
 *  Used by the project menu's "New Terminal" item. */
const ShellOpenTerminalRequest = z.object({ absPath: z.string().min(1) });
const ShellOpenTerminalResponse = z.object({ ok: z.boolean(), error: z.string().nullable() });

/** Hand off the active file to a specific external editor. URL-scheme
 *  approach for the GUI editors that register one (VS Code, Cursor);
 *  CLI spawn for Zed. PRD F6.6. */
const ExternalEditor = z.union([
  z.literal('vscode'),
  z.literal('cursor'),
  z.literal('zed'),
]);
const EditorOpenInRequest = z.object({
  editor: ExternalEditor,
  absPath: z.string().min(1),
});
const EditorOpenInResponse = z.object({
  ok: z.boolean(),
  /** Human-readable detail when ok=false. */
  error: z.string().nullable(),
});

/** Read a text file into the editor zone. Refuses files larger than
 *  maxBytes (default 5 MB) and obvious binaries (NUL byte in first
 *  4 KB). Path must be absolute. */
const FileReadRequest = z.object({
  absPath: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
  /** Session that owns this path. Determines which Fs (local vs SSH)
   *  the read uses. When omitted, defaults to LocalFs for back-compat
   *  with one-off renderer call sites. */
  sessionId: SessionId.optional(),
});
const FileReadResponse = z.object({
  content: z.string(),
  /** mtime in ms — used by the renderer to detect external edits. */
  mtimeMs: z.number(),
  /** True if a binary file would have been refused (we send back an
   *  empty content + the flag so the renderer can show a viewer
   *  fallback instead of an error). */
  binary: z.boolean(),
  /** True if the file was bigger than maxBytes and got rejected. */
  tooLarge: z.boolean(),
  /** File size in bytes (real, not the slice we returned). */
  size: z.number().int().nonnegative(),
});

/** Persist editor changes back to disk. The renderer is expected to
 *  send the latest mtimeMs we returned from file.read so we can
 *  detect a stale write (someone edited the file externally). */
const FileWriteRequest = z.object({
  absPath: z.string().min(1),
  content: z.string(),
  /** mtimeMs at the time the renderer's buffer was loaded. If the
   *  file on disk is newer, the write is refused with `stale: true`
   *  unless `force: true`. */
  knownMtimeMs: z.number().optional(),
  force: z.boolean().optional(),
  sessionId: SessionId.optional(),
});
const FileWriteResponse = z.object({
  ok: z.boolean(),
  /** The new mtimeMs after the write — used by the renderer to refresh
   *  its baseline so subsequent saves don't fail the stale check. */
  mtimeMs: z.number(),
  stale: z.boolean(),
});

/** Read both the HEAD version (`head`) and the working-copy version
 *  (`working`) of a file for the Monaco DiffEditor. PRD F7.3. */
const FileReadGitDiffRequest = z.object({
  absPath: z.string().min(1),
  sessionId: SessionId.optional(),
});
const FileReadGitDiffResponse = z.object({
  /** HEAD contents, or empty if the file is new/untracked. */
  head: z.string(),
  /** Working-copy contents, or empty if the file has been deleted. */
  working: z.string(),
  /** Coarse state, mirrored from worktree.gitStatus for badges. */
  state: z.union([
    z.literal('modified'),
    z.literal('staged'),
    z.literal('untracked'),
    z.literal('deleted'),
    z.literal('conflicted'),
    z.literal('clean'),
  ]),
  /** mtime of the working file (0 when deleted). */
  mtimeMs: z.number(),
});

/** Read a file as base64 — used for images and other binary previews
 *  the editor wants to render directly (PRD F6.2). Caps at 8 MB raw
 *  (~11 MB once encoded) to keep IPC frames reasonable. */
const FileReadBinaryRequest = z.object({
  absPath: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
  sessionId: SessionId.optional(),
});
const FileReadBinaryResponse = z.object({
  /** Base64-encoded bytes. Empty when `tooLarge`. */
  data: z.string(),
  /** Best-effort MIME type derived from extension. */
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  tooLarge: z.boolean(),
});

/** Basic file system operations triggered from the Files / Git context
 *  menus. All paths must be absolute; main is the only side that talks
 *  to fs. Delete uses the OS trash (shell.trashItem) — not rm -rf —
 *  so an accidental click is recoverable from Finder. */
const FileCopyRequest = z.object({
  absPath: z.string().min(1),
  /** Explicit destination. When omitted main generates a sibling
   *  like "<stem> copy<ext>" (and "<stem> copy 2<ext>" if taken). */
  destAbsPath: z.string().min(1).optional(),
  sessionId: SessionId.optional(),
});
const FileCopyResponse = z.object({ destAbsPath: z.string() });

const FileRenameRequest = z.object({
  absPath: z.string().min(1),
  /** New basename — must not contain path separators. */
  newName: z.string().min(1),
  sessionId: SessionId.optional(),
});
const FileRenameResponse = z.object({ newAbsPath: z.string() });

/** Create a new empty file at `absPath`. Refuses to clobber an existing
 *  file. Parent directories are created as needed (mkdir -p), so paths
 *  like "src/new/foo.ts" relative to the worktree root work without
 *  the caller pre-creating the folders. */
const FileCreateRequest = z.object({
  absPath: z.string().min(1),
  sessionId: SessionId.optional(),
});
const FileCreateResponse = z.object({ absPath: z.string() });

const FileDeleteRequest = z.object({
  absPath: z.string().min(1),
  sessionId: SessionId.optional(),
});
const FileDeleteResponse = z.object({ ok: z.literal(true) });

const FileRevealInFinderRequest = z.object({
  absPath: z.string().min(1),
  sessionId: SessionId.optional(),
});
const FileRevealInFinderResponse = z.object({ ok: z.literal(true) });

/** Full-text search across a session's worktree. Backed by `git grep`
 *  in main — searches tracked + untracked-but-not-ignored files. */
const WorktreeSearchRequest = z.object({
  sessionId: SessionId,
  query: z.string().min(1),
  caseSensitive: z.boolean(),
  wholeWord: z.boolean(),
  regex: z.boolean(),
  /** Comma-separated git pathspec globs (e.g. "*.ts, src/**"). Empty
   *  means "everything". */
  includeGlob: z.string(),
  /** Comma-separated git pathspec globs to NEGATE (added as `:!<g>`). */
  excludeGlob: z.string(),
  /** Cap total matches across all files. Default 2 000. */
  maxMatches: z.number().int().positive().optional(),
});
const WorktreeSearchMatch = z.object({
  /** Repo-relative path. */
  file: z.string(),
  line: z.number().int().positive(),
  /** 1-based column of the first character of the match. */
  col: z.number().int().positive(),
  /** Whole line text (untrimmed). */
  lineText: z.string(),
  /** Byte length of the match within `lineText` starting at `col-1`. */
  matchLen: z.number().int().nonnegative(),
});
const WorktreeSearchResponse = z.object({
  matches: z.array(WorktreeSearchMatch),
  /** True if we hit maxMatches and stopped reading further results. */
  truncated: z.boolean(),
  /** Non-null when git grep refused (bad regex, etc). Renderer shows
   *  this verbatim in the panel. */
  error: z.string().nullable(),
});

/** Orphan = a git worktree on disk that doesn't match any session row.
 *  Surfaced read-only here; deletion happens via worktree.removeOrphan. */
const OrphanWorktree = z.object({
  projectId: ProjectId,
  /** Absolute path to the worktree directory. */
  path: z.string(),
  /** Branch name from `git worktree list`, or null for detached HEAD. */
  branch: z.string().nullable(),
});
const WorktreeListOrphansRequest = z.object({});
const WorktreeListOrphansResponse = z.object({
  orphans: z.array(OrphanWorktree),
});

/** A worktree entry surfaced to the renderer for the "pick a worktree"
 *  modal. Mirrors `WorktreeListEntry` in worktreeManager but with the
 *  fields the UI actually needs. */
const WorktreeEntry = z.object({
  path: z.string(),
  branch: z.string().nullable(),
});
const WorktreeListRequest = z.object({ projectId: ProjectId });
const WorktreeListResponse = z.object({
  worktrees: z.array(WorktreeEntry),
});
export type WorktreeEntry = z.infer<typeof WorktreeEntry>;

const WorktreeRemoveOrphanRequest = z.object({
  projectId: ProjectId,
  path: z.string().min(1),
});
const WorktreeRemoveOrphanResponse = z.object({ ok: z.literal(true) });

/** Stage / unstage / commit ops against the worktree of a session.
 *  PRD F7.4. All scoped via sessionId so the renderer doesn't need
 *  to know about repo roots. */
const GitStageRequest = z.object({
  sessionId: SessionId,
  /** Paths relative to the worktree root. */
  paths: z.array(z.string()).min(1),
});
const GitStageResponse = z.object({ ok: z.literal(true) });

const GitUnstageRequest = z.object({
  sessionId: SessionId,
  paths: z.array(z.string()).min(1),
});
const GitUnstageResponse = z.object({ ok: z.literal(true) });

const GitCommitRequest = z.object({
  sessionId: SessionId,
  message: z.string().min(1),
});
const GitCommitResponse = z.object({
  ok: z.literal(true),
  /** Short OID of the new commit, for confirmation toast. */
  oid: z.string(),
});

const GitPushRequest = z.object({ sessionId: SessionId });
const GitPushResponse = z.object({
  ok: z.boolean(),
  /** Combined stdout/stderr for the user — handy for "authentication
   *  failed" or "no upstream" diagnostics. */
  output: z.string(),
});

const GitPullRequest = z.object({ sessionId: SessionId });
const GitPullResponse = z.object({
  ok: z.boolean(),
  output: z.string(),
});

/** Per-session terminal scrollback snapshot (PRD F8.8). The renderer
 *  hands us a SerializeAddon string; main writes it to disk capped
 *  at 5 MB. */
const ScrollbackSaveRequest = z.object({
  sessionId: SessionId,
  /** The full xterm-serialised buffer. May be empty if the session
   *  hasn't produced anything yet. */
  data: z.string(),
});
const ScrollbackSaveResponse = z.object({ ok: z.boolean() });

const ScrollbackLoadRequest = z.object({ sessionId: SessionId });
const ScrollbackLoadResponse = z.object({
  /** Null when no saved snapshot exists (fresh session). */
  data: z.string().nullable(),
});

const PtyWriteRequest = z.object({
  sessionId: SessionId,
  // base64-encoded bytes — see PtyDataFrame for the symmetric inbound type.
  data: z.string(),
});
const PtyResizeRequest = z.object({
  sessionId: SessionId,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const ControlVerbs = {
  'app.ping': { request: Empty, response: PingResponse },
  'app.meta': { request: Empty, response: AppMetaResponse },
  'app.setSelectedSession': {
    request: AppSelectedSessionRequest,
    response: AppSelectedSessionResponse,
  },

  'project.pickFolder': { request: Empty, response: ProjectPickResponse },
  'project.add':        { request: ProjectAddRequest, response: ProjectAddResponse },
  'project.create':     { request: ProjectCreateRequest, response: ProjectCreateResponse },
  'project.list':       { request: Empty, response: ProjectListResponse },
  'project.remove':     { request: ProjectRemoveRequest, response: ProjectRemoveResponse },
  'project.reorder':    { request: ProjectReorderRequest, response: ProjectReorderResponse },
  'project.rename':     { request: ProjectRenameRequest, response: ProjectRenameResponse },
  'project.setSnoozed': { request: ProjectSetSnoozedRequest, response: ProjectSetSnoozedResponse },
  'session.reorder':    { request: SessionReorderRequest, response: SessionReorderResponse },

  'connection.list':     { request: Empty,                     response: ConnectionListResponse },
  'connection.create':   { request: ConnectionCreateRequest,   response: ConnectionCreateResponse },
  'connection.update':   { request: ConnectionUpdateRequest,   response: ConnectionUpdateResponse },
  'connection.delete':   { request: ConnectionDeleteRequest,   response: ConnectionDeleteResponse },
  'connection.test':     { request: ConnectionTestRequest,     response: ConnectionTestResponse },
  'connection.testPath': { request: ConnectionTestPathRequest, response: ConnectionTestPathResponse },
  'connection.reconnect': { request: ConnectionReconnectRequest, response: ConnectionReconnectResponse },
  'connection.listDir':   { request: ConnectionListDirRequest,   response: ConnectionListDirResponse },

  'session.list':   { request: Empty, response: SessionListResponse },
  'usage.getStats':      { request: UsageGetStatsRequest, response: UsageGetStatsResponse },
  'usage.getCodexStats': { request: UsageGetStatsRequest, response: UsageGetStatsResponse },
  'session.spawn':  { request: SessionSpawnRequest, response: SessionSpawnResponse },
  'session.kill':   { request: SessionKillRequest, response: SessionKillResponse },
  'session.resume':     { request: SessionResumeRequest,     response: SessionResumeResponse },
  'session.respawn':    { request: SessionRespawnRequest,    response: SessionRespawnResponse },
  'session.toggleYolo': { request: SessionToggleYoloRequest, response: SessionToggleYoloResponse },
  'session.delete':     { request: SessionDeleteRequest,     response: SessionDeleteResponse },
  'session.rename': { request: SessionRenameRequest, response: SessionRenameResponse },
  'session.setSnoozed': { request: SessionSetSnoozedRequest, response: SessionSetSnoozedResponse },

  'worktree.fileTree':     { request: WorktreeFileTreeRequest,    response: WorktreeFileTreeResponse },
  'worktree.readDir':      { request: WorktreeReadDirRequest,     response: WorktreeReadDirResponse },
  'worktree.gitStatus':    { request: WorktreeGitStatusRequest,   response: WorktreeGitStatusResponse },
  'worktree.list':         { request: WorktreeListRequest,        response: WorktreeListResponse },
  'worktree.listOrphans':  { request: WorktreeListOrphansRequest, response: WorktreeListOrphansResponse },
  'worktree.removeOrphan': { request: WorktreeRemoveOrphanRequest, response: WorktreeRemoveOrphanResponse },
  'worktree.search':       { request: WorktreeSearchRequest,      response: WorktreeSearchResponse },
  'git.stage':             { request: GitStageRequest,             response: GitStageResponse },
  'git.unstage':           { request: GitUnstageRequest,           response: GitUnstageResponse },
  'git.commit':            { request: GitCommitRequest,            response: GitCommitResponse },
  'git.push':              { request: GitPushRequest,              response: GitPushResponse },
  'git.pull':              { request: GitPullRequest,              response: GitPullResponse },
  'shell.openPath':        { request: ShellOpenPathRequest,       response: ShellOpenPathResponse },
  'shell.openTerminal':    { request: ShellOpenTerminalRequest,   response: ShellOpenTerminalResponse },
  'editor.openIn':         { request: EditorOpenInRequest,        response: EditorOpenInResponse },
  'file.read':             { request: FileReadRequest,            response: FileReadResponse },
  'file.readBinary':       { request: FileReadBinaryRequest,      response: FileReadBinaryResponse },
  'file.readGitDiff':      { request: FileReadGitDiffRequest,     response: FileReadGitDiffResponse },
  'file.write':            { request: FileWriteRequest,           response: FileWriteResponse },
  'file.copy':             { request: FileCopyRequest,            response: FileCopyResponse },
  'file.rename':           { request: FileRenameRequest,          response: FileRenameResponse },
  'file.create':           { request: FileCreateRequest,          response: FileCreateResponse },
  'file.delete':           { request: FileDeleteRequest,          response: FileDeleteResponse },
  'file.revealInFinder':   { request: FileRevealInFinderRequest,  response: FileRevealInFinderResponse },

  'pty.write':  { request: PtyWriteRequest, response: Empty },
  'pty.resize': { request: PtyResizeRequest, response: Empty },

  'scrollback.save': { request: ScrollbackSaveRequest, response: ScrollbackSaveResponse },
  'scrollback.load': { request: ScrollbackLoadRequest, response: ScrollbackLoadResponse },
} as const;

export type ControlVerb = keyof typeof ControlVerbs;
export type RequestOf<V extends ControlVerb> = z.infer<(typeof ControlVerbs)[V]['request']>;
export type ResponseOf<V extends ControlVerb> = z.infer<(typeof ControlVerbs)[V]['response']>;

// Backwards-compat exports used by the smoke test
export const PingRequest = Empty;
export { PingResponse, AppMetaResponse, SessionListResponse };
export const SessionListRequest = Empty;

/* ────────────────────────────────────────────────────────────────
 * Event-stream events (push from main → renderer)
 * ──────────────────────────────────────────────────────────────── */

const EventEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  bootId: z.string().uuid(),
  ts: z.number(),
});

const ProjectAddedEvent = EventEnvelope.extend({
  type: z.literal('project.added'),
  project: Project,
});

const ProjectRemovedEvent = EventEnvelope.extend({
  type: z.literal('project.removed'),
  projectId: ProjectId,
});

const ProjectReorderedEvent = EventEnvelope.extend({
  type: z.literal('project.reordered'),
  orderedIds: z.array(ProjectId),
});

const ProjectRenamedEvent = EventEnvelope.extend({
  type: z.literal('project.renamed'),
  project: Project,
});

const ProjectSnoozeChangedEvent = EventEnvelope.extend({
  type: z.literal('project.snoozeChanged'),
  project: Project,
});

const SessionReorderedEvent = EventEnvelope.extend({
  type: z.literal('session.reordered'),
  orderedIds: z.array(SessionId),
});

const SessionSpawnedEvent = EventEnvelope.extend({
  type: z.literal('session.spawned'),
  session: Session,
});

/** Fired the moment main decides to (re)spawn a session, BEFORE the
 *  actual pty round-trip (which can take seconds over SSH). Renderer
 *  uses this to flip the row to a "Starting…" indicator immediately,
 *  so the user isn't staring at a stale `done`/`errored` chip during
 *  boot auto-resume. Cleared on `session.spawned` (success) or
 *  `session.exited` (failed before main returned). */
const SessionStartingEvent = EventEnvelope.extend({
  type: z.literal('session.starting'),
  sessionId: SessionId,
});

const SessionStatusChangedEvent = EventEnvelope.extend({
  type: z.literal('session.status_changed'),
  sessionId: SessionId,
  from: SessionStatus,
  to: SessionStatus,
});

const SessionSummarizedEvent = EventEnvelope.extend({
  type: z.literal('session.summarized'),
  sessionId: SessionId,
  summary: z.string(),
});

const SessionExitedEvent = EventEnvelope.extend({
  type: z.literal('session.exited'),
  sessionId: SessionId,
  exitCode: z.number().nullable(),
});

const SessionDeletedEvent = EventEnvelope.extend({
  type: z.literal('session.deleted'),
  sessionId: SessionId,
});

const SessionRenamedEvent = EventEnvelope.extend({
  type: z.literal('session.renamed'),
  sessionId: SessionId,
  newBranch: z.string(),
  newWorktreePath: z.string(),
});

const SessionTokensUpdatedEvent = EventEnvelope.extend({
  type: z.literal('session.tokens_updated'),
  sessionId: SessionId,
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
});

/** Generic "main re-fetched the row, here's the current state" push.
 *  Used when fields that don't have their own dedicated event change
 *  out-of-band (e.g. autoResume clears claude_session_id when the
 *  transcript is gone). Renderer replaces the row wholesale. */
const SessionRefreshedEvent = EventEnvelope.extend({
  type: z.literal('session.refreshed'),
  session: Session,
});

const ConnectionAddedEvent = EventEnvelope.extend({
  type: z.literal('connection.added'),
  profile: ConnectionProfile,
});

const ConnectionUpdatedEvent = EventEnvelope.extend({
  type: z.literal('connection.updated'),
  profile: ConnectionProfile,
});

const ConnectionRemovedEvent = EventEnvelope.extend({
  type: z.literal('connection.removed'),
  id: z.string().min(1),
});

export const AppEvent = z.discriminatedUnion('type', [
  ProjectAddedEvent,
  ProjectRemovedEvent,
  ProjectReorderedEvent,
  ProjectRenamedEvent,
  ProjectSnoozeChangedEvent,
  SessionReorderedEvent,
  SessionSpawnedEvent,
  SessionStartingEvent,
  SessionStatusChangedEvent,
  SessionSummarizedEvent,
  SessionExitedEvent,
  SessionDeletedEvent,
  SessionRenamedEvent,
  SessionTokensUpdatedEvent,
  SessionRefreshedEvent,
  ConnectionAddedEvent,
  ConnectionUpdatedEvent,
  ConnectionRemovedEvent,
]);
export type AppEvent = z.infer<typeof AppEvent>;

/* ────────────────────────────────────────────────────────────────
 * PTY channel — separate from control. Plain bytes; no Zod parse
 * on the hot path (perf budget, F10.2).
 * ──────────────────────────────────────────────────────────────── */

export const PtyDataFrame = z.object({
  sessionId: SessionId,
  data: z.string(), // base64
});
export type PtyDataFrame = z.infer<typeof PtyDataFrame>;

/* ────────────────────────────────────────────────────────────────
 * Channel names — string constants used by ipcMain/ipcRenderer.
 * ──────────────────────────────────────────────────────────────── */

export const Channels = {
  control: 'baton:control',
  ptyData: 'baton:pty.data',
  events:  'baton:events',
  /** Main → renderer: "user clicked a desktop notification for this
   *  session, please select it in the UI." Carries `{ sessionId }`. */
  selectSession: 'baton:select-session',
} as const;
