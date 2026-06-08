# baton — Measurement Plan

Owner: Data Science. Status: v0 proposal. Refines PRD §8.

We have **zero users at v0**. Every metric here is split into:
- **N0** = measurable on me + early dogfooders (n=1–10)
- **N100** = needs ~100 weekly users for a stable read
- **N1k** = needs ~1k+ for experiment power

## 1. North-star metric proposal

**North star: Weekly Active Agent-Hours per WAU (WAAH/WAU).**

`sum(active_agent_seconds_in_week) / count(WAU) / 3600`, where an active second is one in `running` or `needs-input`. `idle`, `paused`, `done`, `errored` are excluded.

**Why.** The wedge is "the agents work, you supervise" — value scales with how many agent-hours of useful work accumulate per week. One user keeping 4 agents productive 6h/day = ~120 agent-hours/week (the magic); one agent for 30 min/day = ~3.5 (wedge missed).

It satisfies the constraints:
- **Measurable in 90 days.** Status transitions come for free from Claude Code hooks (F3.1, F3.2) via one event (`session.status_changed`). No inference needed.
- **Correlates with core value.** A solo dev tops out near 40 hours/week of attention; the supervisor wedge unlocks 2–5× via parallelism.
- **Hard to game.** Idle/done are excluded, so leaving agents open doesn't inflate it. The remaining game ("loop agents forever") is caught by guardrails G4 (summarizer cost) and G7 (HITL timeout): if WAAH/WAU rises while $/hour explodes, we're gaming.

**Rejected.** *Concurrent active agents* — snapshot, not flow. *TTN* — latency, not value. *Sessions completed* — gameable by short sessions. *Time-saved-vs-alt-tab* — too many modelling assumptions.

**Targets.** Dogfood (n=1): ≥60 WAAH/week by week 4. Beta (n≈20): median 25. Public (n≈1k): median 15, p75 ≥40.

## 2. Guardrail metrics

Optimizing the north star must not regress any of these. Alarms fire if any breach the target for ≥2 consecutive weeks.

| # | Metric | Definition | Target | Severity |
|---|---|---|---|---|
| G1 | p95 main-process CPU at 5 active agents | Sampled every 30 s from `process.cpuUsage()` | ≤25% on M-series Mac | P0 |
| G2 | p95 RSS at 5 active agents | Renderer + main RSS | ≤1.2 GB | P0 |
| G3 | p99 status-transition latency | Hook fire → chip color change (renderer paint) | ≤500 ms | P1 |
| G4 | Summarizer $/active-agent-hour | `summarizer_tokens × price / active_hours` | ≤$0.05 (per NF3) | P0 |
| G5 | False-positive needs-input rate | `(needs-input transitions where user took no action AND status reverted within 30 s) / total needs-input transitions` | ≤5% | P1 |
| G6 | App crashes per 100 session-hours | `app.crash` events / session-hours × 100 | ≤0.5 | P0 |
| G7 | HITL timeout rate | `hitl.timed_out / hitl.created` | ≤10% (a high rate means the radar isn't working) | P1 |

G5 catches the worst failure mode: making the radar so jumpy users mute it. G4 catches the obvious "throw a bigger model at it" temptation.

## 3. Activation, engagement, retention

### Activation (24 h after first launch)

User must, within 24 h, hit all of: (1) `project.added` ≥ 2, (2) `session.spawn` ≥ 2, (3) `notification.fired` ≥ 1 AND `notification.clicked` ≥ 1.

Formula: `activated_users / first_app.start` per daily cohort. Target 35% at N100, 45% at N1k (narrow ICP justifies a higher bar than horizontal SaaS).

PRD §8 said "2 projects + 1 agent in 5 minutes." Too easy — one agent never exercises the radar. We raise to 2 agents and require a notification round-trip.

### Engagement

- **DAU/WAU (stickiness):** target ≥0.5 — daily-use tool.
- **Agents spawned / WAU / week:** target median ≥10 at N1k.
- **Concurrent-peak / WAU / week:** max simultaneous `running`+`needs-input` per user-week. Target median ≥3 (proves parallelism).
- **Radar-chip clicks / active-hour:** direction metric — should fall over time as notifications carry the load.

### Retention

Cohort by week of activation. **D1** ≥60%, **D7** ≥40%, **D28** ≥30%. Also track **D28 WAAH retention**: fraction of activated users still hitting ≥10 WAAH in week 4 (stricter than logged-in retention).

## 4. Success metric definitions (refining PRD §8)

### Activation (refined)

- **Plain:** Did the user feel the wedge in their first session?
- **Formula:** `(project.added≥2 ∧ session.spawn≥2 ∧ notification.fired≥1 ∧ notification.clicked≥1 in 24h of first app.start) / first_app.start`
- **Target:** 35% at N100; narrow ICP justifies the floor.
- **Instrumentation:** events 2, 3, 6, 10, 11.
- **Horizon:** 24 h rolling, cohorts weekly.
- **Confounds:** users blocked by `setup_script.failed` look deactivated — track that as a separate funnel step.

### Time-to-notice needs-input (TTN)

- **Plain:** From `needs-input` transition to user action.
- **Formula:** `median(first_user_action_ts − needs_input_ts)`, where action = earliest of `notification.clicked`, `radar.chip_clicked` for that session, `terminal.input`, or `hitl.approved/denied`.
- **Target:** median ≤30 s, p90 ≤120 s.
- **Instrumentation:** events 6, 7, 11, 13.
- **Horizon:** rolling 7-day.
- **Confounds:** AFK looks like regression. Winsorize at 30 min and report alongside `notification.dismissed` rate. **Broken signal:** p90 > 10 min AND notification-click rate < 20% → notifications aren't working.

### Polling-rate reduction

- **Plain:** Are users still clicking in "just to check"?
- **Formula:** `radar.chip_clicked` with no follow-up (no terminal input, diff scroll, or file open within 30 s) per active-hour.
- **Target:** ≤0.5/hour after week 2. (PRD's "80% reduction" lacks a baseline — see §9.)
- **Instrumentation:** events 11, 14.
- **Horizon:** per user per week, 4-week smoothing.
- **Confounds:** users who *enjoy* watching agents. Gating on no-follow-up separates polling from engaged supervision.

### Summary usefulness

- **Plain:** Are summaries good enough to skip the terminal?
- **Proxy A (behavioural):** `1 − (terminal_focus_within_5s_of_summary_update / summary_updates)`. Frequent fly-to-terminal = the summary failed.
- **Proxy B (explicit, 1/50 sampled thumbs):** `thumbs_up / (thumbs_up + thumbs_down)`.
- **Target:** A ≥0.7, B ≥0.8.
- **Instrumentation:** events 8, 11, 14.
- **Horizon:** 7-day rolling.
- **Confounds:** users open the terminal to type, not read — gate Proxy A on read-only focus (no `terminal.input` in the window).

## 5. Telemetry event spec

Every event carries: `event_id` (UUID), `ts` (ms), `user_id` (anonymous, generated locally), `install_id`, `app_version`, `os`, `boot_id`, `seq`. All sampled at real-time unless marked.

| # | Event | When fired | Key properties | Sample | PII |
|---|---|---|---|---|---|
| 1 | `app.start` | Main process ready | cold_start_ms, restored_session_count | real-time | none |
| 2 | `app.crash` | Renderer crash / main uncaught | reason_class, last_event_seq | real-time | none |
| 3 | `project.added` | User completes "add project" flow | project_id (hash of path), had_setup_script | real-time | path is **hashed** |
| 4 | `project.removed` | User removes project | project_id | real-time | none |
| 5 | `project.opened` | User focuses project pane | project_id | sampled 1/5 | none |
| 6 | `session.spawn` | After `git worktree add` + agent backend `spawn` resolves | session_id, project_id, backend_id, worktree_was_new, setup_script_ran, setup_script_failed | real-time | none |
| 7 | `session.status_changed` | Hook-derived enum transition | session_id, from, to, latency_from_hook_ms | real-time | none |
| 8 | `session.summarized` | Summarizer produced a summary | session_id, model_id, input_tokens, output_tokens, latency_ms, cache_hit | real-time | summary text **NOT** sent |
| 9 | `session.kill` / `session.resume` / `session.exit` | Lifecycle ops | session_id, reason | real-time | none |
| 10 | `notification.fired` | Main process `new Notification(...)` | session_id, trigger (needs-input/done/errored), surface (desktop/dock/in-app) | real-time | none |
| 11 | `notification.clicked` | OS click callback | session_id, ms_since_fired | real-time | none |
| 12 | `notification.dismissed` / `notification.ignored` | OS dismiss / expired after 5 min unacked | session_id, ms_since_fired | real-time | none |
| 13 | `hitl.created` / `hitl.approved` / `hitl.denied` / `hitl.timed_out` | Feed lifecycle | request_id, session_id, tool_class (no command text), wait_ms | real-time | tool **class** only (e.g. `bash`, `write`), never command body |
| 14 | `ui.engagement` | Roll-up event for clicks | kind (radar_chip / file_tab / diff_view / layout_toggle / cmd_palette), session_id?, ms_since_last | sampled 1/1 but coalesced 250 ms | none |
| 15 | `perf.sample` | Every 30 s | cpu_main, cpu_renderer, rss_main, rss_renderer, xterm_queue_depth_p95, ipc_rtt_p95_ms | sampled 30 s | none |
| 16 | `summarizer.error` | Summarizer call failed | error_class, retry_count | real-time | none |
| 17 | `git.op` | Write op completes | op (commit/push/worktree_add), duration_ms, ok | real-time | none |

PII rule applied: we never carry file content, prompt content, diff content, summary text, command lines, or branch names. `project_id` is `sha256(absolute_path)[:16]`. `tool_class` for HITL is an enum, never the raw command. See §7.

## 6. A/B / experiment ideas

Opt-in only. Sample sizes assume α=0.05, power=0.8, two-sided, baselines from N100 pilot.

- **E1. Split vs Tabbed default.** H: Split (always-visible Conversation) raises engagement. Primary: `radar_click → diff_view_open within 60 s` rate. Secondary: WAAH/WAU, TTN. n≈600 (300/arm), 3 weeks.
- **E2. LLM summary on/off.** H: summaries cut polling. A = summarizer on (default), B = status icons only. Primary: polling rate (§4). Guardrail: $/hour in A. n≈400, 2 weeks.
- **E3. Native notification vs in-app only.** H: native + dock badge crushes TTN vs in-app list. Primary: TTN median. n≈300 (TTN is sensitive), 2 weeks.
- **E4. Per-session cost cap default.** A = none, B = $5 soft cap, C = $20 soft cap. Primary: weekly retention + sessions-completed-per-spawn. Guardrail: cap-triggered HITL volume. n≈900, 4 weeks.
- **E5. Worktree-per-agent vs shared-per-branch.** H: shared is fine for 1 agent/branch users and saves disk + setup time. Primary: session error rate (`errored/spawn`). Secondary: disk growth, setup wallclock. n≈500, 3 weeks.

## 7. Privacy & consent

**Strict opt-in.** First launch modal, default OFF (per NF5). Settings ships a "View what we send" inspector showing the last 100 outgoing events — devs will inspect, so we make it cheap.

**Collected:** the §5 events — counts, durations, latencies, status enums, anonymous IDs.

**Never collected:** code content, diff content, prompt content, summary text, terminal output, command strings (HITL stores tool *class*: `bash` / `write` / `network` — never the command body), file paths or branch names (paths hashed; branches bucketed `main` / `feature` / `worktree`), email or system identity.

**IDs.** `install_id` = local UUID in `~/.baton/install_id`. `user_id` is the same value, never linked to any account. Delete the file → next launch is a new install.

**Storage.** Local JSONL buffer (`~/.baton/telemetry.jsonl`, 200 MB ring) → HTTPS batch every 5 min → 90 days raw, then aggregated.

**Deletion.** Settings → "Delete my telemetry" tombstones `install_id` server-side within 7 days.

**Confirming "no code/diff/prompt content."** Yes — none of it is sent. We still measure usefulness:
- *Summary quality:* Proxy A (behavioural) + opt-in Proxy B thumbs.
- *HITL:* wait_ms + approve/deny + tool class.
- *Diff engagement:* opens, scroll depth, time-on-diff.
- *Agent productivity:* status transitions and durations.

Signals we can't reach privately (e.g. "was the summary literally correct") become explicit feedback events, not silent collection.

## 8. Aggregation & dashboards

Three roll-ups: **per session** (active-hours, cost, error rate, HITL count), **per user-week** (sums/averages over the user's sessions), **per project** (project-week metrics to spot e.g. monorepo regressions).

### Weekly review (1 screen, every Monday)

Top — **North star + guardrails**, last 8 weeks sparkline + delta:
```
[ WAAH/WAU ▁▂▃▅▆ +12% ]  [ p95 CPU 18% ✓ ]  [ Summ $/hr $0.04 ✓ ]
[ Crashes /100h 0.3 ✓ ]  [ FP needs-input 3% ✓ ]  [ HITL timeout 7% ✓ ]
```

Second — **Activation funnel** (this-week cohort):
```
First launch → +project ≥2 → +session ≥2 → +notif fired → +notif clicked
   100%          78%            55%             49%            41% (activated)
```

Third — **Engagement & retention:** DAU/WAU trend; cohort retention heatmap; concurrent-peak histogram (how parallel are users really being?).

Fourth — **Quality signals:** TTN median + p90 with notification-click rate alongside; polling rate; summary Proxy A + thumbs ratio; top 5 `summarizer.error` classes + crash reasons.

Side panel — **Experiments in flight** with current effect and sample-size progress.

Footer — **Opt-in rate** (% of installs sending telemetry this week) so we know how representative the data is.

## 9. Open questions

1. **Polling-rate baseline.** PRD targets 80% reduction but we have no "before" data. Do we ship a 1-week shim that measures alt-tab cadence in the user's existing VS Code workflow before they switch? `[+ NEW]` "Baseline week" mode.
2. **Measuring "shipped."** WAAH is a proxy; the truer metric is PRs merged from agent work / week. We could read git log locally on tracked projects (count only, per §7). Worth it — much stronger outcome metric. `[+ NEW]` `git.commits_authored_by_agent` event.
3. **TTN winsorization.** 30 min is a guess. Should we bucket-report instead (≤30 s / 30 s–5 min / 5–30 min / AFK) to avoid hiding the tail?
4. **Cost-cap experiment timing.** If $5 default is too low, new users hit the cap mid-flow and bounce. Do we delay E4 until the activation funnel is stable so the effects don't conflate?
5. **Where do summary thumbs live?** In-product UI for a 1/50 sample is noisy. Alternative: `[+ NEW]` `tfa feedback` CLI verb devs run when a summary annoys them — better signal-to-noise, zero UI cost.
