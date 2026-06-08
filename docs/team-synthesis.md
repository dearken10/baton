# Team synthesis — baton PRD v2 input

Round-1 inputs from PM, PMM, Designer, Researcher, Data Scientist,
Engineering Architect are all in. This doc:

1. Names the strategic decisions you need to make.
2. Lists tactical PRD patches I can apply once you green-light them.
3. Filters the ~20 `[+ NEW]` proposals with a recommendation per item.
4. Flags conflicts between specialists.
5. Proposes the order of next moves (Reviewer round vs. ship patches first).

---

## 1. Round-1 deliverables (where each file lives)

| Specialist | File | Key call |
|---|---|---|
| PM | `pm-additions.md` | 7 use cases, 18 user stories, acceptance criteria + edge cases per F-section, **5 scope cuts including drop tabbed layout**, 9 `[+ NEW]` |
| PMM | `positioning.md` | ICP sharpened, category coined ("parallel-agent supervisor"), positioning statement, launch hook, naming review, free OSS + paid cloud posture |
| Designer | `design-review.md` + 3 new HTML mockups | Critique of all 3 mockups, IA, **recommends split-only v1**, accessibility audit, 3 new mockup files |
| Researcher | `research-brief.md` | Audit of every pain + PRD claim with evidence, **flags LLM-summary as the existential risk**, **flags ICP scope risk**, 4-week research plan with W4 gate decision |
| Data Scientist | `metrics-plan.md` | **North star: WAAH/WAU**, 7 guardrails, 17 telemetry events, 5 A/B experiments, opt-in privacy plan |
| Eng Architect | `architecture-review.md` | Feasible but **over-scoped for v1**, **NF3 budget math broken**, **defer F7.4/F7.5/F11.3/F11.4/F10.2-external to v1.1**, 4-week W1–W4 v0 plan |

---

## 2. Strategic decisions you need to make

These are not patches — they change the product. My recommendation is in
each, but they're your calls.

### D1. Drop tabbed layout for v1; ship split-only?

- **PM ("Cut 5"), Designer ("split is right default"), Researcher (untestable from public data — instinct)** all converge on dropping tabbed.
- You explicitly said earlier "we can ship both."
- The team's argument: two layouts double the test matrix for F6.4/F6.5/resizing, and "two layouts day 1" reads as indecision. Add tabbed in v1.1 if small-laptop users actually demand it.
- **My recommendation: agree with the team. Drop tabbed for v1.** The Conversation-is-always-visible invariant survives either way (split: top region; tabbed: pinned tab). Split is the more opinionated, less ambiguous shape.
- **Your call:** keep both / drop tabbed / re-examine.

### D2. The LLM-summary feature might be the wrong bet — gate it on a Week-3 experiment?

- **Researcher's biggest finding:** no shipping competitor uses LLM-summarized status (cmux, Conductor, Warp, Agent View all use *tool names + badges*). Stack Overflow 2025: 66% frustrated by "almost-right" AI, 46% distrust accuracy.
- If summaries are wrong even 5% of the time, users re-read the terminal anyway and the value evaporates. We become "fancier cmux."
- **DS's north star (WAAH/WAU) doesn't catch this** — users may spawn agents while ignoring the summary line.
- **Architect's NF3 problem amplifies this:** at the PRD's 5s cadence on Haiku 4.5, real cost is ~$0.54/hr/agent (10× the budgeted NF3 of $0.05/hr). Even if summaries are useful, they're 10× over budget.
- **My recommendation: keep LLM summary as a v1 feature but treat as a hypothesis.** Apply NF3 fix (30s cadence + hook-driven + ≤20 lines, see P-A1 below) AND run Researcher's Week-3 throwaway experiment (5 friendly devs, 5-day dogfood, instrument summary-viewed and terminal-click-through). Gate "keep / cut / change form" decision on Week-4 result.
- **Your call:** keep as planned / Week-3 experiment then decide / cut now and ship tool-names + badges only.

### D3. ICP scope — multi-project only, or also single-project-multi-agent?

- Researcher found most public power users (Steinberger 3–8 agents, Cherny 5 sessions, bulk of HN parallel-agent threads) work **one project, many branches** — not many projects.
- **PMM doubled down on multi-project** in the positioning ("parallel-agent supervisor"). Variant A statement disqualifies cmux ("single-project") explicitly.
- This is a real tension: the wedge is sharper as "cross-project radar," but the addressable market may be larger as "many agents, one project."
- **My recommendation: keep multi-project as the *headline* wedge (it's our true differentiator vs cmux/Conductor), but design the left column so single-project users get value too.** Three concrete moves:
  1. Treat "one project, many sessions" as a first-class layout state — don't penalize it in the IA.
  2. Add the onboarding survey question Researcher proposed: "how many projects this week?" — track distribution.
  3. Soften the disqualification language in positioning ("cmux is single-project" → "cmux is terminal-only").
- **Your call:** stay strict on multi-project / expand the ICP / launch and measure.

### D4. Architect proposes deferring 5 F-requirements to v1.1. Approve which?

| F-req | What it is | PM stance | Architect stance | My rec |
|---|---|---|---|---|
| F7.4 inline diff comments | Comment on hunk → structured agent context | Keep | Defer to v1.1 | **Defer** — high build cost; users can workaround via composer |
| F7.5 combined diff | Multi-file diff view | Keep | Defer to v1.1 | **Defer** — Monaco DiffEditor solo is enough for v1 |
| F11.3 daily/weekly cost rollup | Aggregate spend footer | Keep | Defer to v1.1 | **Keep** — cheap; cost visibility is part of the wedge per PMM |
| F11.4 per-session cost cap | Soft cap with HITL prompt | **Cut** (PM Cut 2) | Defer to v1.1 | **Defer** — agree; non-trivial interaction with F3.8 |
| F10.2 external Unix socket | CLI/external tooling can drive baton | (not addressed) | Defer to v1.1 | **Defer** — no external consumers exist yet |

- **Also consider PM's cuts** that Architect didn't comment on:
  - **F5.4 ripgrep search** — PM cuts (wedge is supervision not navigation). **My rec: cut** for v1.
  - **F6.2 PDF + CSV viewers** — PM cuts. **My rec: cut PDF; keep CSV** (agents do emit CSV for benchmarks). Or cut both, do markdown + images + JSON.
  - **Second AgentBackend implementation** — PM keeps trait, cuts implementation. **My rec: agree** — Codex is v2.
- **Your call:** any "keep" instead of my "defer"?

### D5. Naming — keep baton, or pressure-test Helm / Foreman?

- PMM honest about baton cons: pronunciation ambiguity, digit-leading breaks conventions, SEO collision, off-brand associations.
- Recommends keeping baton through beta, pressure-testing **Helm** and **Foreman** in 20 ICP interviews before public launch.
- Helm has hard Kubernetes-Helm collision. Foreman has mild Procfile collision but stronger vibe.
- **My recommendation: agree with PMM — keep baton through beta, run the name test in Researcher's interview Week 1–2.** Add a single question to the interview script.
- **Your call:** lock baton / lock another / defer.

---

## 3. Tactical patches I can apply directly (no strategic call needed)

I won't apply these until you say "go." Each is a small PRD edit.

### P-A1. Fix NF3 cost budget math
- **Current:** NF3 = `≤ $0.05/hr/active-agent`. F4.2 = "every 10s" cadence (PRD has both 10s and 5s in places — inconsistent).
- **Reality (Architect):** at 5s × Haiku 4.5 × 500 in / 50 out tokens ≈ **$0.54/hr** — 10× over.
- **Fix:**
  - **F4.2** cadence: "every 30s while active OR on every Claude Code hook event (whichever comes first), with a 5s floor between consecutive calls per session."
  - **F4.3** input cap: "summarizer input ≤20 lines of tail buffer + last 3 hook events, cached on identical inputs."
  - **NF3** target: `≤ $0.05/hr/active-agent at default cadence; $0.20 ceiling, alarmable above.`
  - Add "low-budget mode" toggle (default off): cadence 60s, no LLM call until ≥1 hook event since last summary.

### P-A2. Reinforce hook-derived status (F3.2)
- **Current:** "Status is inferred from a combination of: pty activity (bytes in last N seconds), Claude Code hook events…"
- **Fix:** Reorder + sharpen — "Status comes **primarily** from Claude Code hooks (SessionStart, PreToolUse, Notification, Stop, SessionEnd). pty heuristics are a fallback for hookless agents only."

### P-A3. Single IPC bus — concrete schema rules
Add to F10.1:
- All verbs declared as Zod schemas; CI compares snapshot, fails on drift.
- `pty.data` lives on its own channel (not shared with control verbs) to prevent backpressure starving status events.
- External Unix socket: defer to v1.1 (per D4).

### P-A4. setup.sh trust + hash (new F1.5)
From Architect's threat model. The dominant attack: malicious `setup.sh` (e.g. `postinstall` of a dependency).
- **F1.5 (new):** First-run `setup.sh` requires explicit user confirmation. Hash stored in SQLite; any change re-prompts.
- **F1.6 (new):** `setup.json` supports `dry_run: true` mode showing what would run without executing.

### P-A5. Demo mode (new F2.8)
- **F2.8 (new):** First launch shows a `Demo` button that spawns a `MockAgentBackend` with a scripted transcript. Exercises radar + summary + HITL without requiring Claude credentials. Drops time-to-wow.
- Already-shipped in Architect's W2 plan as `MockAgentBackend`.

### P-A6. Accessibility patches (mockups)
Designer's audit — apply to all HTML mockups:
- Bump `--text-faint` from `#5b6068` to `#7a8088` (AA pass).
- Lighten comment token from `#6a9955` to `#7eb87a`.
- Add `:focus-visible` outline + offset shadow on every clickable.
- Wrap pulse animations in `@media (prefers-reduced-motion: reduce) { animation: none }`.
- Add `role`, `aria-label` for status badges, sessions, tabs.
- Add shape/glyph per status (`▶ ⏸ ✓ ⚠ ✕`) for color-blind users.

### P-A7. Acceptance criteria block per F-section
PM produced testable acceptance criteria for 12 F-sections. Fold into PRD as a new `§6 Acceptance criteria` or inline per F-section. PM also produced 18 Given/When/Then user stories — fold as `§7 User stories (selected)`.

### P-A8. v0 milestone plan
Architect's 4-week W1–W4 plan is concrete enough to ship as `§12 v0 milestone`. Names which F-reqs are in v0, stubbed, killed; weekly demoable.

### P-A9. Telemetry event spec
DS's 17-event table + privacy guarantee folds into PRD as `§11 Telemetry & metrics`. Reaffirms NF5 (opt-in) and pins the **never-collected list** (code, diffs, prompts, summary text, commands, file paths, branch names).

### P-A10. North-star + guardrails into success metrics (§8 rewrite)
- **North star:** Weekly Active Agent-Hours per WAU.
- **Guardrails (7):** CPU/RSS at 5 agents, p99 status latency, summarizer $/active-hour, FP needs-input rate, app crashes/100h, HITL timeout rate.
- **Activation:** 2 projects + 2 agents + notification round-trip in 24h. (PRD's "2 projects + 1 agent" was too easy.)
- **TTN:** median ≤30s, p90 ≤120s.

### P-A11. Drop "Conductor's #1 complaint" framing
Researcher couldn't independently verify the specific ranking I claimed. Soften:
- **prior-art.md** §C: "Cost visibility was the most consistently raised complaint across blog posts, HN threads, and Conductor changelog" rather than "founder's #1."

### P-A12. Document worktree containment honestly
Per Architect: an agent runs as the user with full FS perms. We *cannot* sandbox without macOS Endpoint Security or a separate user — both out of scope.
- **F2.1** spawn confirmation: "This agent has access to your home directory, not just the worktree."
- Matches Claude Code's own model.

### P-A13. Update positioning + masthead with PMM language
- Title page: add the category tag "parallel-agent supervisor."
- §2 problem section: pull in Variant A positioning statement.
- Add §10 (or appendix) with the positioning doc cross-referenced.

### P-A14. Onboarding survey question
From Researcher and DS — add to onboarding flow:
- "How many projects do you work on in a typical week?" (single-select: 1 / 2–3 / 4–6 / 7+)
- "How many AI agents do you run in parallel?" (single-select: 1 / 2–3 / 4–6 / 7+)
- This is the data we need to validate D3 (ICP scope).

---

## 4. `[+ NEW]` proposals — filter sheet

20 proposals across agents. Vote for me to **Accept (fold into PRD)**,
**Defer (note for v1.1)**, or **Reject**. My recommendation in `My rec`;
your call in the last column when you reply.

### From PM (9)

| # | Proposal | Source | My rec | Your call |
|---|---|---|---|---|
| N-1 | **Agent inbox** — Cmd+Shift+I list of every chip in `needs-input`/`errored`, sorted by age | UC-1, UC-3 | **Accept** — same surface as the radar, low cost, high-leverage at 5+ sessions | |
| N-2 | **Per-agent intent label** — user-editable persistent label on the chip | UC-2 | **Accept** — worktree name is for git, label is for humans; cheap | |
| N-3 | **Idle-timeout auto-pause** — auto-paused after N min of no activity | F11 spirit | **Accept** — directly addresses silent token burn (DS G4 guardrail backs this) | |
| N-4 | **"Why did the chip change?" log** — transitions modal | trust-building | **Defer** — value depends on summary feature; tie to D2 outcome | |
| N-5 | **Deny-with-reason** in HITL card | F3.8 | **Accept** — saves the deny-then-explain round-trip, structured input | |
| N-6 | **Snapshot before destructive approval** — `git stash create` ref + one-click undo | safety | **Accept** for v1.1; **note now** — the snapshot is cheap, the undo-UI is the work | |
| N-7 | **Worktree disk-usage indicator** + cleanup action | F7 | **Accept** — Architect also calls out worktree leak detection | |
| N-8 | **Settings split: per-project vs global** | UX clarity | **Accept** — explicit IA, no new feature, just discipline | |
| N-9 | **HITL keyboard row** — A/D/R/Esc | power flow | **Accept** — trivial to ship | |

### From Architect (4)

| # | Proposal | Source | My rec | Your call |
|---|---|---|---|---|
| N-10 | **`setup.json --dry-run`** — show what would run | threat model | **Accept** (covered in P-A4) | |
| N-11 | **`setup.sh` first-run trust + hash** | threat model | **Accept** (covered in P-A4) | |
| N-12 | **Daily aggregate budget circuit breaker** — pause-all if daily cap exceeded | cost runaway | **Accept** — different from F11.4 (per-session); deserves its own F-req | |
| N-13 | **Demo mode via MockAgentBackend** | activation | **Accept** (covered in P-A5) | |

### From Data Scientist (3)

| # | Proposal | Source | My rec | Your call |
|---|---|---|---|---|
| N-14 | **"Baseline week" mode** — measure user's alt-tab cadence in their existing workflow before baton takes over | polling-rate baseline | **Defer** — research-side trick, complex to ship cleanly; revisit | |
| N-15 | **`git.commits_authored_by_agent` event** — measure "shipped" not just "active" | outcome metric | **Accept** — count-only, per privacy guarantee; stronger outcome metric than WAAH | |
| N-16 | **`tfa feedback` CLI verb** — devs thumbs from terminal | summary thumbs | **Accept** — better signal/noise than in-product UI; almost free | |

### From Designer (4)

| # | Proposal | Source | My rec | Your call |
|---|---|---|---|---|
| N-17 | **Per-session cost cap in new-agent dialog** | mockup-new-agent | **Defer** — Designer adds, PM cuts (F11.4); resolve via D4 → defer either way | |
| N-18 | **Triage queue in right column** | mockup-collapsed-sessions | **Reject** — N-1 (Agent inbox) covers it more cleanly | |
| N-19 | **Today-spend gauge** in right column | mockup-collapsed-sessions | **Defer** — covered by F11.2 titlebar total | |
| N-20 | **Density toggle (comfy/dense/tiny)** | mockup-collapsed-sessions | **Defer** — only useful at 15+ sessions; revisit if users hit density walls | |

---

## 5. Conflicts between specialists

Worth surfacing — these aren't all on you to resolve, but they shape priorities.

### C1. Cost visibility — feature or guardrail?
- **DS:** F11.4 is a guardrail (G4 summarizer cost), not a feature.
- **PM:** F11.4 should be cut entirely.
- **Designer:** F11.4 is featured prominently in new-agent dialog.
- **PMM:** cost visibility is one of three top messages.
- **Resolution:** keep visibility (F11.1 + F11.2 + F11.3) as a feature; cost *cap* (F11.4) is the disputed piece. Defer F11.4 (D4) and revisit once shipping data shows cap need.

### C2. WAAH/WAU vs trust-in-summary
- **DS** north star (WAAH/WAU) measures *parallelism utilization*.
- **Researcher** flags trust-in-summary as the existential risk.
- These don't conflict directly — but WAAH can rise even if the summary feature is bad (users still spawn agents and check terminals). Track both.
- **Resolution:** WAAH/WAU is the north star; **add "summary trust score" (Proxy A + thumbs) as a co-primary measure for v1.** No promoting one at the cost of the other.

### C3. Multi-project framing
- **PMM** doubles down (positioning Variant A).
- **Researcher** says single-project may be larger segment.
- **Resolution:** D3 above.

### C4. macOS-only sustainability
- **PMM** lists macOS-only in anti-ICP — honest.
- **Researcher:** "every shipped winner is Mac-only" (cmux, Conductor, Solo). Validates the choice.
- **Architect:** Electron is cross-platform-ready when we choose, but no urgency.
- **Resolution:** lock macOS for v1, **stop apologizing for it**. The ICP is on macOS.

### C5. Same-branch parallel sessions
- We added the shared-branch UI grouping earlier.
- **Architect** says: two agents on same branch with worktree-per-agent = two separate FS copies, no conflict.
- **PM** edge case: `withLock` serializes; second offered fresh branch.
- These are consistent. **No action.**

---

## 6. What I propose for round 2

You have three reasonable next moves. Pick one:

### Option A — Ship the patches and the Reviewer pass in one shot
1. You make the D1–D5 calls + filter the `[+ NEW]` table.
2. I apply every settled patch (P-A1 through P-A14) to PRD.md, mockups, and prior-art.md.
3. I spawn a single **Reviewer/Editor agent** to read v2 end-to-end and produce a punch list + polish pass.
4. We iterate on the punch list.
**Pro:** fastest path to a coherent v2. **Con:** locks in decisions before the Reviewer sees them.

### Option B — Reviewer first, then patches
1. I write a `v2-DRAFT.md` that *includes* the unsettled decisions as inline `[DECISION NEEDED: …]` markers.
2. Reviewer reads the draft + the team outputs and produces a meta-critique that may change your D1–D5 answers.
3. You make calls informed by the Reviewer's pass.
4. I apply patches.
**Pro:** an independent voice before you commit. **Con:** another agent round (~10 min, more $$).

### Option C — Settle the strategic Ds with you over the next message, then run B
1. We resolve D1–D5 conversationally first.
2. Then a Reviewer agent reads the settled v2 draft.
3. Final polish pass.
**Pro:** highest-quality output. **Con:** slower; needs your engagement on each D.

**My recommendation: C.** D1–D3 are big enough that an external reviewer
can't make them for you, and reviewing a draft with unresolved [DECISION
NEEDED] markers gets a messier brief. Resolve the Ds with me, then send a
clean v2 to one Reviewer for the polish.

---

## 7. Open meta-question for you

**Are you building this, or commissioning the spec?** The whole synthesis
changes depending on the answer:

- If you'll build it solo: the v0 plan + Architect's W1–W4 is your week-1
  Monday morning. PRD is for *you*. Skip PMM polish; focus on F-reqs +
  acceptance criteria.
- If you'll hand it off (engineer hire, contractor, agency): PMM's launch
  positioning, full F-reqs, telemetry plan, and 4-week milestone matter.
  Spec needs to stand without you in the room.
- If you'll pitch it for funding: tighten positioning, surface the 4-week
  v0 as a credible plan, lean on Researcher's evidence. Architect's
  detail is overhead.

This shapes how aggressive Option C's Reviewer pass should be.

---

Reply with D1–D5 calls + `[+ NEW]` accept/defer/reject + Option choice
and I'll execute.
