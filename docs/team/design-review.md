# Design Review: baton

Reviewed: `mockup.html`, `mockup-tabbed.html`, `mockup-split.html`, `mockup.md`,
plus PRD F-sections and `prior-art.md`.

## 1. Existing mockup critique

### `mockup.html` (3-column, conversation-only middle)

What works:

- **Shared-branch grouping** with the left-rail accent and `↳ wt-a / wt-b`
  hierarchy is the strongest single idea across all three files. It surfaces
  the worktree-per-agent concept visually without a new mental model.
- The **overlap warning** (`also editing src/auth/session.ts — sibling wt-b
  touched it 00:42 ago`) is a thoughtful safety affordance. Belongs in PRD F2.
- Status chip colors and the pulsing dot are calm, not noisy.
- Project-card density is correct for ~5–8 sessions.

What doesn't:

- **No editor anywhere.** Per F6.1 the editor is supposed to be center-pane.
  This mockup ignores the F6 split-vs-tabbed question entirely — it's a
  monitoring mockup, not the PRD's supervisor + IDE-lite product.
- **The right column tabs File and Git** — but the user almost always wants
  both visible (files to navigate, diff to review). Click-fatigue.
- **No layout toggle UI.** F6.3 ships both layouts; no affordance to switch.
- **Project headers are decorative** — no collapse, no aggregate status,
  no spend total. Wasted real estate past 6 projects.
- **Summary lines wrap to 2 lines per card.** ~140px × 6 sessions = 840px of
  scroll already. Won't scale to 5–10 agents, let alone 15+.
- **No keyboard hints** in the chrome itself. PRD references Cmd+1..9,
  Cmd+Shift+U, but none are surfaced.

### `mockup-tabbed.html` (pinned Conversation tab + scrollable file tabs)

What works:

- **Pinned Conversation tab with the blue divider** is a clear visual
  invariant — maps cleanly to Zed's Panel/Pane distinction (prior-art §B).
- **Unread badge on the Conversation tab** solves "I missed an agent message
  while reading a file" — direct on PRD F6.4.
- Horizontally scrollable file tab strip is correct for an IDE-shaped product.

What doesn't:

- **Tab strip horizontal scroll is a UX trap.** Past ~6 tabs the user can't
  see what's open without scrolling, and there's no overflow chevron menu.
- **Two tab strips on screen** (middle file tabs + right Files/Git tabs).
  The user has to remember which strip drives what.
- **The 📌 pin emoji on the Conversation tab** looks closeable. Replace with
  a left-edge accent bar and drop the glyph.
- **Unsaved files only marked in the tab strip,** not in the project tree.
  They get out of sync the moment a tab is closed.
- **Where does Diff go?** F6.x has File/Editor/Diff modes. Tabbed punts.

### `mockup-split.html` (file tabs top, editor, conversation bottom)

What works:

- **Conversation pinned at the bottom of the pane** mirrors a chat app's
  composer-at-the-bottom affordance — the most intuitive layout for
  "the agent talks to me while I read code."
- Horizontal drag handle is correctly placed and visually understated.
- File-tabs-top + editor + chat-bottom is a known good pattern
  (Cursor, Crystal, VS Code + Copilot Chat docked).

What doesn't:

- **The 1.1:1 split ratio is wrong.** F6.3 specifies ~52%/48%. The
  conversation region contains head + transcript + composer; the composer
  ends up cramped on smaller windows.
- **The composer is far from the file under review.** Commenting on line 42
  forces eye traversal across most of the screen.
- **Conv-summary is buried** at the top of the conversation region (bottom
  of the pane). PRD wants it glanceable; it's the opposite.
- **No collapse-conversation shortcut** for heads-down coding (e.g. `⌘\`).

### Common to all three

- **Dark-only.** No light theme; many devs use light for screenshare/a11y.
- **Contrast failures.** `--text-faint` (#5b6068) on `--bg-1` is ~2.4:1 —
  fails AA. That's the color of `wt-a · 03:18 · $0.41` lines, half the chrome.
- **No focus rings** on any clickable. Tab navigation is visually broken.
- **Cost shown per chip but never aggregated.** F11.2 wants titlebar total.

## 2. Information architecture

3 columns is right; the model is incomplete. The main surface mirrors the
user's mental model (which agent? what is it saying? what is it changing?).
Missing: second-class surfaces for everything outside the steady-state loop.

**Top-level (always reachable)**
- Main Workspace (3 columns)
- Titlebar — title, layout toggle, total spend, notifications, palette, settings
- Notification drawer — right slide-in, last 50 transitions, filter chips
- Command palette (Cmd+K) — modal: jump to project/session/file, run commands
- Status footer — slim bar: counts, daily spend, event count `[+ NEW]`

**Secondary screens (modal or full-pane)**
- Onboarding / Welcome — first launch, sign in / connect first project / agent backend
- Empty state — no projects added; replaces the workspace
- Settings — General · Notifications · Summarizer · Agent backends · Setup script · Cost caps · Keyboard · Appearance
- Cost dashboard — per-session + daily/weekly + caps
- Audit log viewer — JSONL HITL log scroll with filters `[+ NEW]`

**Inline modals / panels**
- New-agent dialog · HITL approval card (inline in conversation)
- Commit dialog · discard confirmation
- Add-project file picker (system) · per-project settings drawer

**Resolutions.** Settings → full-pane modal (single source); per-project
config is a drawer from the project context menu. Notifications → titlebar
bell → right slide-in. Cost dashboard → titlebar `$4.18` chip → full-pane.
Command palette → Cmd+K modal.

## 3. Layout toggle UX

- **Global, not per-session.** Per-session forces users to remember which
  session is in which layout — confusing. Global matches VS Code's mental model.
- **Persisted** as `ui.middlePane.layout = 'split' | 'tabbed'`. Restored on launch.
- **Surface 1:** titlebar pill `[Layout: split ▾]` → click → dropdown switch
  (already in the tabbed/split variants; adopt for the main mockup too).
- **Surface 2:** Settings → Appearance → radio with small preview thumbnails.
- **Keyboard:** `⌘⌥L` toggles (`⌘L` is Monaco line-select).
- **Transition:** 200ms animated reflow; selected file/tab preserved.

I'd push back on shipping both. **Split is the right default for the ICP**;
tabbed is a power-user concession. Ship split-only in v1, add tabbed in v1.1
if there's demand. The "two layouts day 1" feels like indecision.

## 4. Missing-screen list (ranked)

1. **Empty state** (P0) — first thing a new user sees.
2. **First-run onboarding** (P0) — 3-step: sign in / first project / backend.
   Activation metric depends on this.
3. **New-agent dialog** (P0) — path to a *second* session; the path to
   "actually using the product."
4. **Command palette** (P1) — without it, navigation at scale is mouse-only.
5. **Collapsed-sessions / dense mode** (P1) — critical to the supervisor
   positioning at 15+ sessions.
6. **HITL approval card** (P1) — inline, semaphore-backed (F3.8).
7. **Settings** (P1) — global prefs, summarizer, backends, setup script.
8. **Errored agent state** (P2) — last 50 lines, restart, kill, copy error.
9. **Cost dashboard** (P2) — per-session + daily + caps.
10. **Notification drawer** (P2).
11. **Layout toggle interaction** (P2) — pill covers it.
12. **Light theme variant** (P3).

I'm shipping new HTML for **3, 4, 5** — highest leverage.

## 5. Accessibility + theming notes

- **AA contrast.** `--text-faint` #5b6068 on `--bg-1` is ~2.4:1; bump to
  `#7a8088` (~3.6:1) or restrict to non-essential metadata. The comment
  syntax token `#6a9955` is ~3.0:1 on `--bg`; lighten to `#7eb87a`.
- **No `:focus-visible`.** Every clickable needs a 2px `--accent` outline
  plus `box-shadow:0 0 0 4px rgba(91,141,239,0.25)`.
- **No `prefers-reduced-motion` guard.** Wrap the pulse animations:
  `@media (prefers-reduced-motion: reduce) { animation: none; }`.
- **No ARIA.** Sessions need `role="button"` (or `treeitem`); status badges
  need `aria-label="status: running"` — the uppercase text is contextless
  to a screen reader.
- **Color is the only status signal** in the HTML chips (the ASCII `🔴`/`⏸`
  glyphs were dropped). Add a shape/glyph per status (▶ ⏸ ✓ ⚠ ✕) for
  color-blind users.
- **Theming.** Define both `:root` (dark) and `[data-theme="light"]`. The
  status hue mapping is the hard part — `#5b8def` reads "running" in dark
  but feels too cold in light; desaturate or hue-rotate warmer.

## 6. Open design questions

1. **Collapsible conversation in split mode?** A heads-down coding mode
   might want it as a one-line strip (project · agent · status · summary)
   expandable on focus. User-test.
2. **Radar at 20+ sessions on a 13" MBP** — compare the dense in-app mode
   against a menubar mini-radar living outside the main window.
3. **HITL card placement.** Inline is right for the active session, but
   when 3 sessions are simultaneously waiting, the user wants one queue
   view of pending approvals. Notification drawer? A new Approvals surface?
4. **Cost-cap prompt UX.** Same shape as the tool-permission HITL card,
   or a distinct paywall-style modal? Probably distinct.
5. **Worktree cleanup discoverability.** Killed sessions leave worktrees
   on disk. Today: nowhere surfaces this. Proposal: "Orphan worktrees (3)"
   in the project context menu. Needs a wireframe.

---

## New mockups produced

1. `mockup-new-agent.html` — new-agent dialog (backend pick, branch,
   LLM-named worktree preview, initial prompt, setup-script confirm,
   options including `[+ NEW]` per-session cost cap).
2. `mockup-command-palette.html` — Cmd+K overlay: scoped search
   (`in: needs-input`), prefix modes (`>`, `#`, `:`, `@`), and result
   sections for Sessions / Files / Commands / Projects with kbd hints.
3. `mockup-collapsed-sessions.html` — dense one-line-per-session left
   column with status-filter strip, project aggregate dots, collapsible
   project headers, density toggle, and a centre-pane radar grid grouped
   by status (`[+ NEW]` triage queue + today-spend gauge on the right).
