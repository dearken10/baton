# PRD — Settings

**Status:** Implemented (v1) · **Owner:** Ken · **Scope:** the app-wide
Settings surface in baton and the contract for adding new settings to it.

---

## 1. Why

Settings were scattered: theme lived in a titlebar toggle backed by
`localStorage`, OTEL telemetry config was reachable only through a
one-off modal, and column widths / editor tabs sat in ad-hoc
`localStorage` keys. There was no single place a user looks to configure
the app, and no agreed pattern for *where a new setting should live*.

This PRD defines **one canonical Settings surface** — a single modal,
opened from the titlebar ⚙ — that hosts every user-facing preference, and
the rules for extending it so future settings land consistently instead
of sprouting new one-off toggles.

**Principle:** *if it's a user preference, it goes in Settings.*

---

## 2. Goals / Non-goals

**Goals**
- One entry point (titlebar ⚙) → one modal for all preferences.
- A **sectioned** layout (left nav + panel) that scales to many
  categories without a redesign.
- A documented, low-friction way to add a new setting (§6).
- Correct persistence semantics per setting type (§4), including *when a
  change takes effect*.

**Non-goals (for now)**
- Per-project setting overrides (settings are global / per-machine).
- Settings sync across machines or import/export.
- A searchable settings palette (revisit once there are >~4 sections).
- Managed/enforced settings (enterprise `managed-settings.json`-style
  lockdown).

---

## 3. UX

- **Entry point:** a ⚙ button in the titlebar (replaces the old standalone
  theme toggle — theme now lives inside Settings).
- **Layout:** a modal with a **left section nav** and a **right panel**.
  Sections in v1:
  - **Appearance** — theme (Light / Dark).
  - **Telemetry** — OpenTelemetry export (enable, endpoint, protocol,
    email).
- **Footer:** `Close` always; a `Save` button appears only for sections
  that need an explicit commit (see §4). Escape and overlay-click close.

```
┌ Settings ─────────────────────────────────────────────┐
│                                                        │
│  ┌───────────┐  Appearance                             │
│  │Appearance◄│  ─────────────                          │
│  │Telemetry  │  Theme   [ ☾ Light | ☀ Dark ]           │
│  └───────────┘  Applies instantly, remembered locally. │
│                                                        │
│                              [ Close ]                 │
└────────────────────────────────────────────────────────┘
```

---

## 4. Architecture — two persistence tiers

Not all settings are the same. A setting falls into exactly one tier;
the tier dictates storage, apply-timing, and whether it needs `Save`.

### Tier A — Renderer-local prefs (instant, `localStorage`)
Pure UI state the main process doesn't need. Applies **immediately** on
change and persists synchronously; **no Save button**, no IPC.

- **Why:** things like theme must apply before any IPC round-trip to
  avoid a flash-of-wrong-value at boot (theme is read + applied at module
  load — see `src/renderer/src/lib/theme.ts`).
- **Examples:** theme; (future) column widths, font size, editor prefs.
- **Storage:** `localStorage` under a `baton:<key>` namespace.

### Tier B — Main-persisted settings (explicit Save, SQLite + IPC)
Anything the **main process** consumes — because it configures how agents
are spawned, how the app talks to external services, etc. Loaded over IPC
when the dialog opens; committed on **Save**.

- **Why:** the value is read by main at the point of use (e.g. spawn),
  so it must live where main can read it: the SQLite `settings` table.
- **Examples:** OTEL config (`otel` key). (Future: default permission
  mode, default model, notification prefs.)
- **Storage:** `settings` table (`key TEXT PRIMARY KEY, value TEXT`),
  one JSON blob per logical setting, via `src/main/services/settingsStore.ts`.
- **IPC:** one get/set verb pair per setting, Zod-validated in
  `src/shared/ipc.ts` (e.g. `settings.getOtel` / `settings.setOtel`).

### Apply-timing contract
Every Tier-B setting must state **when a change takes effect** and the UI
must say so. OTEL is read **once per session at spawn**, so the panel
notes: *"Changes take effect on the next session spawn — running sessions
keep the config they launched with."* Future settings that apply live
(or need a restart) must surface that just as explicitly.

### Defaults from the environment
Tier-B defaults for a fresh install may seed from environment variables
rather than hardcoded constants (team convention: defaults belong in the
environment, not the code). OTEL seeds `endpoint` / `protocol` from
`OTEL_EXPORTER_OTLP_*` when present, but stays **disabled** until the user
opts in.

---

## 5. Data & IPC contract (v1)

**`OtelSettings`** (`src/shared/ipc.ts`)
```ts
{ enabled: boolean;
  endpoint: string;                       // OTLP, e.g. http://host:4317
  protocol: 'grpc' | 'http/protobuf';
  userEmail: string; }                    // → `user` resource attribute
```

**Verbs**
| Verb | Request | Response | Notes |
|---|---|---|---|
| `settings.getOtel` | `{}` | `{ otel: OtelSettings }` | reads store, falls back to env-seeded defaults |
| `settings.setOtel` | `OtelSettings` | `{ otel: OtelSettings }` | overwrites wholesale; effective next spawn |

Theme (Tier A) has **no IPC** — it's `localStorage` only.

---

## 6. How to add a new setting (the extension contract)

**Tier A (renderer-local):**
1. Add a tiny store in `src/renderer/src/lib/` (mirror `theme.ts`:
   load-at-module, `set`, `subscribe`, a `use…` hook).
2. Add a control to the relevant section panel in `SettingsDialog.tsx`
   (or a new section — see below). Apply on change; no Save.

**Tier B (main-persisted):**
1. Define + export a Zod schema in `src/shared/ipc.ts`; register a
   `settings.getX` / `settings.setX` verb pair; add both to the
   `ipc.test.ts` snapshot.
2. Add `getX` / `setX` (and any `buildXEnv`-style helper) to
   `settingsStore.ts`, stored as a JSON blob under a new `settings` key.
3. Add a handler pair in `src/main/ipc/bus.ts`.
4. Consume it at the point of use in main (guarded/no-op when unset).
5. Render the control in `SettingsDialog.tsx`; load on open, commit on
   Save; **state the apply-timing** in the panel copy.

**Adding a section:** append to the `SECTIONS` array in
`SettingsDialog.tsx` and add a branch in the panel switch. The nav and
layout pick it up automatically. No migration for a schema of settings
is needed — each setting owns its own row/key.

---

## 7. Current sections

| Section | Tier | Setting(s) | Applies |
|---|---|---|---|
| Appearance | A | theme (light/dark) | instantly |
| Telemetry | B | OTEL enable / endpoint / protocol / email | next session spawn |

---

## 8. Future settings (backlog — not committed)

- **Agent defaults** — default permission mode, default model, default
  backend (claude-code vs codex). *(Tier B.)*
- **Notifications** — desktop-notification toggles, idle thresholds.
- **Appearance+** — font size, terminal font, compact density.
- **Jira** — remember last ticket, ticket regex/prefix (currently
  hardcoded to the `IMBEE-…` convention in `src/shared/jira.ts`).
- **Skill marketplace** — subscribe/update the private plugin
  marketplace (from the analytics POC brief).

---

## 9. Risks / notes

- **Two tiers can confuse** ("why does theme not need Save but OTEL
  does?"). Mitigation: Save only renders for Tier-B sections; Tier-A
  controls read as instantly-applied and say so.
- **Stale drafts.** Tier-B state is re-loaded every time the dialog
  opens, so a config changed elsewhere isn't overwritten by an old draft.
- **No per-project scope yet.** All settings are global/per-machine; if a
  future setting genuinely needs per-project values, that's a schema
  change (a `project_settings` table), not a new `settings` key.
