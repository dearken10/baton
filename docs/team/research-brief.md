# baton — Research Brief: Assumption Audit

Author: User Researcher · Date: 2026-06-06

Audits pain-points.md and PRD.md against public evidence (HN, dev surveys, vendor docs, practitioner blogs, GH issues). Distinguishes "evidence found" from "speculative."

---

## 1. Assumption audit — pain points

### P1. No global view of every active session
**Supports:** Anthropic shipped Agent View (`claude agents`) in v2.1.139, marketed as "one screen for all your sessions" — a vendor signal users were complaining ([Anthropic](https://code.claude.com/docs/en/agent-view)). Conductor, cmux, Crystal, Omar TUI, Herdr, Solo, Warp, Agent Bar, ClaudeBar all converge on this surface. Omar's Show HN: "context switching and cycling through each terminal tab was a real pain" ([HN 47978340](https://news.ycombinator.com/item?id=47978340)).
**Challenges:** Boris Cherny runs 5 sessions with just iTerm2 notifications ([Medium](https://jpcaparas.medium.com/who-to-follow-if-youre-serious-about-claude-code-0d49abe2d521)). One HN commenter "could not meaningfully run more than three sessions" — addressable pain shrinks at low N ([HN 45489884](https://news.ycombinator.com/item?id=45489884)).
**Verdict: Well-supported** at N≥4 sessions; mixed below.

### P2. Cannot monitor status without visiting each session
**Supports:** [GH anthropics/claude-code#58965](https://github.com/anthropics/claude-code/issues/58965) — Anthropic's own Agent View shows "working" even while waiting on permission prompts. Warp explicitly markets agent notifications "so you know exactly when an agent needs your attention" ([Warp docs](https://docs.warp.dev/agent-platform/warp-agents/capabilities-overview/agent-notifications)).
**Verdict: Well-supported.**

### P3. Lost track of which session
**Supports:** Crystal & cmux ship LLM-named worktrees because index labels failed users. HN mentions color-coding tabs, Stage Manager grouping, Aerospace tilers as workarounds ([HN 45489884](https://news.ycombinator.com/item?id=45489884)).
**Challenges:** Conductor's city-name workspaces seem to suffice; no quantitative survey.
**Verdict: Well-supported, moderate severity.**

### P4. Round-robin polling
**Supports:** Hatica/PanDev cite 25-min refocus time and ~40% productivity loss for multi-project devs ([Hatica](https://www.hatica.io/blog/context-switching-killing-developer-productivity/); [PanDev](https://pandev-metrics.com/docs/blog/context-switching-kills-productivity)); Atlassian 2025 ranks tool-switching #3. Conductor blog: "context switching and cycling through each terminal tab was a real pain" ([madewithlove](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)).
**Caveat:** Numbers measure human task-switching, not 30-sec glance loops.
**Verdict: Well-supported in spirit; magnitude is extrapolation.**

### P5. Permission prompts sit unanswered
**Supports:** ScaleX "Agent Permission Fatigue" post ([scalex.dev](https://scalex.dev/blog/ai-agent-permissions/)). Pushary: "stuck on a basic Y/N approval prompt for 30 minutes" ([Product Hunt](https://www.producthunt.com/p/pushary/how-do-you-stay-aware-of-what-your-ai-coding-agents-are-doing)). GH #58965 confirms Anthropic's own dashboard misclassifies this state.
**Verdict: Well-supported.**

### P6. No push notification on need/done
**Supports:** Warp markets this as headline; cmux's notification ring is core; Anthropic added a Notification hook event for permissionprompt/idleprompt ([Claude Code hooks](https://code.claude.com/docs/en/hooks)).
**Verdict: Well-supported.**

### P7. Terminal output is ephemeral and hard to skim
**Supports (partial):** Crystal v0.3.1 admitted "2800ms+ frame drops during terminal output." cmux's status badges and Agent View status column accept the premise.
**Challenges:** I found **no public source** explicitly asking for an LLM-summarized "intent" line. Existing dashboards show *tool names* (PreToolUse: Bash), not natural-language summaries. The leap from "show status" to "LLM-summary as the fix" is novel and unvalidated.
**Verdict: Mixed.** Status-skim problem real; summary-as-cure unsupported.

### "What I want" list
Maps 1:1 to cmux, Agent View, Conductor, Warp. **Well-supported in shape.** The unique add — integrated file tree + diff + git — sees thinner evidence (see §2-F).

---

## 2. Assumption audit — PRD specifics

### A. Worktree-per-agent default (F2.2)
**For:** Anthropic recommends `isolation: worktree` for subagents ([Claude Code docs](https://code.claude.com/docs/en/worktrees)); Conductor, Crystal, cmux default this way.
**Against:** Steinberger runs 3-8 Codex instances **in the same folder** for speed ([steipete.me](https://steipete.me/posts/just-talk-to-it)). Worktrees break on node_modules duplication, missing .env, cold Vite/Next caches ([gitworktree.org](https://www.gitworktree.org/guides/gitignore)). F1.4's setup script is a band-aid.
**Verdict: Mixed.** Defensible default; setup script is essential.
**v0 test:** "Use main checkout" toggle on agent spawn; if >30% pick it, default is wrong.

### B. LLM summary makes raw output skippable (G3, F4)
**For:** None found. No shipping competitor uses LLM-summarized status — they show tool names + badges.
**Against:** Stack Overflow 2025: 66% cite "AI that's almost right" as #1 frustration; 46% distrust accuracy ([SO 2025](https://survey.stackoverflow.co/2025/ai)). A Haiku summary lands in this trust gap; if devs distrust it they re-read the terminal and the value collapses.
**Verdict: Unsupported. Riskiest novel bet in the PRD.**
**v0 test:** Instrument click-into-terminal per summary update; target ≥80% drill-down reduction across n≥10 (PRD currently n=1).

### C. Conversation always visible (F6.3-6.5)
**For:** Zed's Panel-vs-Pane architecture treats conversation as always-dockable; Crystal v0.3.4 panel refactor was user-driven.
**Against:** Pure designer instinct. Conductor and Warp let you collapse the conversation without revolt.
**Verdict: Untestable from public data — instinct.**
**v0 test:** Ship both split + tabbed; instrument mode preference and toggle frequency.

### D. Cost visibility is #1 complaint about parallel agents (F3.3, F11)
**For:** Every parallel-agent blog leads with cost ([madewithlove](https://madewithlove.com/blog/conductor-running-multiple-ai-coding-agents-in-parallel/)). Theo Browne burned $168/prompt, hit $100/mo cap in 23 min ([BigGo](https://finance.biggo.com/news/392ca1e1dadddb7f)); Steinberger $1.3M/month ([TheNextWeb](https://thenextweb.com/news/openclaw-peter-steinberger-1-3-million-openai-token-bill)). Anthropic ended agent subscription-subsidy June 15 ([TechTimes](https://www.techtimes.com/articles/317625/20260602/anthropic-ends-subscription-subsidy-agents-june-15-credit-pool-replaces-flat-rate-access.htm)) — implicit admission.
**Against:** Could **not** independently verify the specific "Conductor founder said #1" claim. Concern is recurrent; the ranking is unverified.
**Verdict: Well-supported in general; specific ranking unverified.**
**v0 test:** Ship chip-cost meter + soft cap; measure unprompted "cost shock" support emails.

### E. ICP = multi-project devs
**For:** Marc Lou ships 16+ products ([Indie Hackers](https://www.indiehackers.com/post/how-marc-lou-phs-maker-of-the-year-makes-50k-every-month-with-multiple-products-45074ee30a)); Levels.io runs Nomad List + Remote OK + Photo AI; context-switching studies center multi-project devs.
**Against:** Steinberger's 3-8 agents are mostly **same folder**; Boris Cherny's 5 sessions aren't clearly cross-project; most HN parallel discussion is **one project, many branches**. Single-project-multi-agent may be the larger segment.
**Verdict: Mixed.** PRD positioning may exclude single-project power users.
**v0 test:** Onboarding question "how many projects this week?" — track distribution.

### F. cmux-leaves-IDE-wedge-open (G5-G6)
**For:** Conductor sells the same wedge (workspace + diff + git) and has paying users. Solo says cmux is "not a process manager."
**Against:** **Crystal got deprecated on this exact wedge**, team said "too thin." That's stronger evidence than the PRD weighs it.
**Verdict: Mixed, leaning risky.**
**v0 test:** Track in-app editor vs "Open in VS Code" (F6.6) click-through. >50% escape-hatch = editor is dead weight.

### G. Electron over native AppKit (PRD §7)
**For:** Cross-platform reach for the 51% of devs who aren't on Mac ([SO 2025](https://survey.stackoverflow.co/2025/ai)).
**Against:** **Every shipped winner is Mac-only** (cmux native, Conductor Tauri-Mac, Solo Mac). Electron's 150-300MB/window × 10 projects = 1.5-3GB shell overhead, may breach NF2.
**Verdict: Mixed.** Right velocity call for MVP; cross-platform TAM unproven.

---

## 3. Untested assumptions ranked

**Existential (wrong → product doesn't work):**
1. LLM summary is trusted enough to skip raw output. SO data says it won't be.
2. Target user really runs ≥4 parallel sessions long enough to feel polling tax.
3. Polling is genuinely painful, not mildly annoying.

**Important (wrong → rebuild a feature):**
4. Conversation always-visible vs easily-toggled.
5. Worktree-per-agent as default (Steinberger contradicts).
6. Per-project setup script solves the worktree gap.
7. Integrated Monaco editor + diff replaces VS Code for supervisor flow.
8. Hook-based status > pty heuristics for non-Claude agents (Gemini emits no Stop).

**Cosmetic (cheap to be wrong):**
9. LLM-named worktrees beat sequential names.
10. Native macOS notifications vs in-app toast preference.
11. Haiku 4.5 as default summarizer model.

---

## 4. Discovery interview script (45 min)

ICP candidate: confirmed runs multiple AI agents in parallel.

**Warm-up (10 min)**
1. Walk me through your last full workday — windows, what was running, order.
2. Peak agent sessions yesterday? Same project or different?
3. Spinning up a new agent: first five clicks/keystrokes?

**Specific incidents (15 min)**
4. Last time an agent got stuck waiting on you without you noticing — what happened, how did you find out, what did it cost?
5. Last time you opened a window and couldn't remember what that agent was doing — how did you figure it out?
6. Last cost surprise — token spend, API bill, rate-limit hit. What earlier signal would have helped?
7. Two agents conflicting on the same files or DB — what happened?

**Workarounds (10 min)**
8. Scripts, hotkeys, tools you've cobbled together — tmux layouts, hooks, colors?
9. Show me your `.claude/settings.json`. What did you write yourself?
10. Tools you tried and stopped (cmux, Conductor, Agent View, Warp, Crystal). Why?

**Willingness to pay / dealbreakers (5 min)**
11. If a tool gave back the time you spend "just checking" daily — worth what per month? (Don't anchor.)
12. Single feature whose absence makes you uninstall within a week?
13. Smallest thing you'd try before committing to a new desktop app?

**Wrap (5 min)**
14. Who else runs agents like you do? Whose workflow have you copied?
15. Wave-a-wand: one thing about your current setup that would change?

Anti-leading rules: no "would you use baton," no "do you wish you had X," no "would you pay for Y." Past behavior or dollar spend only.

---

## 5. ICP candidate list — public figures

1. **Peter Steinberger (@steipete)** — runs 3-8 Codex instances daily, $1.3M tokens in a month. Most aligned with the supervisor pain. [steipete.me](https://steipete.me/posts/just-talk-to-it).
2. **Jesse Vincent (blog.fsck.com)** — codified Architect/Implementer parallel pattern; builds Superpowers. [blog.fsck.com](https://blog.fsck.com/2025/10/05/how-im-using-coding-agents-in-september-2025/).
3. **Simon Willison (@simonw)** — author of "Embracing the parallel coding agent lifestyle." Runs Datasette + LLM CLI + side projects. [simonwillison.net](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/).
4. **Theo Browne (@t3dotgg)** — vocal Claude Code critic, runs t3.gg + Ping + Upload Thing; high-impact skeptical validator. [github.com/t3dotgg](https://github.com/t3dotgg).
5. **Marc Lou (@marc_louvion)** — 16+ products in 2 years, prototypical multi-project indie hacker. [Indie Hackers](https://www.indiehackers.com/post/how-marc-lou-phs-maker-of-the-year-makes-50k-every-month-with-multiple-products-45074ee30a).
6. **Pieter Levels (@levelsio)** — Nomad List + Remote OK + Photo AI; publicly praised Claude Code for "fixing small bugs from old projects" — multi-project supervisor flow.
7. **Josh Bleecher Snyder** — "7 Prompting Habits of Highly Effective Engineers," cited by Willison.
8. **bredmond1019 (dev.to)** — "Multi-Agent Orchestration: Running 10+ Claude Instances in Parallel." [dev.to](https://dev.to/bredmond1019/multi-agent-orchestration-running-10-claude-instances-in-parallel-part-3-29da).
9. **shideneyu (Rmux creator, Show HN May 2026)** — built adjacent tool; ideal "why did you build your own?" interview.
10. **andrew.ooo (Rmux reviewer)** — reviews multiplexers for agents.

Approach: lightweight email/DM, $150 incentive (market rate for senior devs), lead with their published material, no baton pitch in first message.

---

## 6. Biggest "this could be wrong" risk

**The LLM-generated one-line summary may be the wrong unit of information.** The PRD bets its central differentiator (G3, F4, success metric #4) on Haiku-summarized "what is the agent doing right now" — a feature no shipping competitor uses. Every other dashboard (cmux, Agent View, Warp, Conductor) surfaces *tool names* + *status badges* — objective data users can verify, where a generated summary is an artifact they'll distrust the moment it's wrong once. Stack Overflow 2025 (66% frustrated by "almost-right" AI, 46% distrust accuracy) says the trust budget is already overdrawn. If the summary needs to be trusted enough to skip the terminal and it's wrong 5% of the time, users read the terminal anyway — and we've built a fancier cmux for no incremental value. The fallback (tool names + badges like everyone else) is fine, but then the unique wedge collapses to "cmux + IDE pane" — the wedge Crystal just walked away from.

---

## 7. Research plan — next 4 weeks

**Week 1 — discovery.** DM 8 ICP candidates from §5; book 5 interviews. Deploy 6-question survey to r/ClaudeAI, r/cursor, X via @simonw/@steipete (parallel sessions count, same-project vs cross-project, daily "checking" time, last notification tool, last surprise cost, one feature you'd pay for). Lurk Anthropic GH issues; cluster raw tickets.

**Week 2 — interviews + Figma.** Run 5 interviews using §4 script. Build clickable Figma of radar + status chip + cost meter + LLM-summary slot. **No code.** Mid-week: 3 corridor tests on whether the summary text is trustworthy enough that users *don't* click through.

**Week 3 — summary experiment.** Single-window Electron app that tails one Claude Code session, calls Haiku 4.5 every 10s, displays summary banner. **No radar, editor, project list.** Ship to 5 friendly devs (Steinberger, Vincent + 3 from survey) for 5-day dogfood. Instrument: summary-viewed events, click-through rate, end-of-day 3-question accuracy form.

**Week 4 — synthesize and gate.** Decision: does summary-trust survive dogfood? **Yes →** green-light full PRD. **No (>40% click-through OR median accuracy <3/5) →** pivot G3 to "tool-name + badge" stack. Run 5 more interviews biased toward **Conductor/cmux churners**. Write v1 ICP with measurable inclusion criteria (≥3 parallel sessions, ≥2 projects, ≥2 hours/day in supervision).

**EOW4 deliverables:** updated PRD verdicts on §3 ranking; 10 interview syntheses; summary-trust writeup; refined ICP.

---

## Sources

All citations inline above. Primary: Anthropic docs (agents, agent-view, worktrees, hooks); HN threads 45489884, 45596024, 46682551, 47978340; GH anthropics/claude-code#58965; Stack Overflow 2025 Developer Survey; Hatica + PanDev context-switching reports; Simon Willison, Jesse Vincent, Peter Steinberger blogs; Conductor/cmux/Warp/Solo product pages; Indie Hackers + Marc Lou + Levels.io.
