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

export const Project = z.object({
  id: ProjectId,
  path: z.string(),
  name: z.string(),
  addedAt: z.number(),
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

const ProjectAddRequest = z.object({ path: z.string().min(1) });
const ProjectAddResponse = z.object({ project: Project });
const ProjectListResponse = z.object({ projects: z.array(Project) });
const ProjectPickResponse = z.object({ path: z.string().nullable() });

const ProjectRemoveRequest = z.object({ projectId: ProjectId });
const ProjectRemoveResponse = z.object({ ok: z.literal(true) });

const ProjectReorderRequest = z.object({ orderedIds: z.array(ProjectId).min(1) });
const ProjectReorderResponse = z.object({ ok: z.literal(true) });

const SessionReorderRequest = z.object({ orderedIds: z.array(SessionId).min(1) });
const SessionReorderResponse = z.object({ ok: z.literal(true) });

const SessionListResponse = z.object({ sessions: z.array(Session) });

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
 *  cwd, reusing the same code24 session id. No `--resume` — the prior
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
const FileReadGitDiffRequest = z.object({ absPath: z.string().min(1) });
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
});
const FileCopyResponse = z.object({ destAbsPath: z.string() });

const FileRenameRequest = z.object({
  absPath: z.string().min(1),
  /** New basename — must not contain path separators. */
  newName: z.string().min(1),
});
const FileRenameResponse = z.object({ newAbsPath: z.string() });

const FileDeleteRequest = z.object({ absPath: z.string().min(1) });
const FileDeleteResponse = z.object({ ok: z.literal(true) });

const FileRevealInFinderRequest = z.object({ absPath: z.string().min(1) });
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
  'project.list':       { request: Empty, response: ProjectListResponse },
  'project.remove':     { request: ProjectRemoveRequest, response: ProjectRemoveResponse },
  'project.reorder':    { request: ProjectReorderRequest, response: ProjectReorderResponse },
  'session.reorder':    { request: SessionReorderRequest, response: SessionReorderResponse },

  'session.list':   { request: Empty, response: SessionListResponse },
  'usage.getStats': { request: UsageGetStatsRequest, response: UsageGetStatsResponse },
  'session.spawn':  { request: SessionSpawnRequest, response: SessionSpawnResponse },
  'session.kill':   { request: SessionKillRequest, response: SessionKillResponse },
  'session.resume':     { request: SessionResumeRequest,     response: SessionResumeResponse },
  'session.respawn':    { request: SessionRespawnRequest,    response: SessionRespawnResponse },
  'session.toggleYolo': { request: SessionToggleYoloRequest, response: SessionToggleYoloResponse },
  'session.delete':     { request: SessionDeleteRequest,     response: SessionDeleteResponse },
  'session.rename': { request: SessionRenameRequest, response: SessionRenameResponse },

  'worktree.fileTree':     { request: WorktreeFileTreeRequest,    response: WorktreeFileTreeResponse },
  'worktree.gitStatus':    { request: WorktreeGitStatusRequest,   response: WorktreeGitStatusResponse },
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

const SessionReorderedEvent = EventEnvelope.extend({
  type: z.literal('session.reordered'),
  orderedIds: z.array(SessionId),
});

const SessionSpawnedEvent = EventEnvelope.extend({
  type: z.literal('session.spawned'),
  session: Session,
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

export const AppEvent = z.discriminatedUnion('type', [
  ProjectAddedEvent,
  ProjectRemovedEvent,
  ProjectReorderedEvent,
  SessionReorderedEvent,
  SessionSpawnedEvent,
  SessionStatusChangedEvent,
  SessionSummarizedEvent,
  SessionExitedEvent,
  SessionDeletedEvent,
  SessionRenamedEvent,
  SessionTokensUpdatedEvent,
  SessionRefreshedEvent,
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
  control: 'code24:control',
  ptyData: 'code24:pty.data',
  events:  'code24:events',
  /** Main → renderer: "user clicked a desktop notification for this
   *  session, please select it in the UI." Carries `{ sessionId }`. */
  selectSession: 'code24:select-session',
} as const;
