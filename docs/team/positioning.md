# baton — Positioning

## 1. ICP — fleshed out

**Title / seniority.** Senior or staff engineer, or technical founder, 6–15 years in. Hands-on coder, writing more code than two years ago because agents made shipping cheaper.

**Team + role.** Two shapes: **solo indie / technical founder (1–3 person team)** owning 2–5 surfaces (web, mobile, marketing, internal tooling, side bet) and shipping to prod; or **senior engineer at a 10–200 person Series A/B** owning 2–3 services plus one or two "20%" projects, already opening 4–6 VS Code windows.

**Daily workflow (weekday).**
- **08:30** — Coffee. Four VS Code windows restore. Starts a Claude Code in each, queues tasks.
- **09:00–10:30** — Deep work on one project; three agents run in the background.
- **10:30** — Alt-tabs four windows. Finds one stuck on a permission prompt from 20 minutes ago. Mutters.
- **10:32–12:00** — Reviews diffs, answers prompts, queues next tasks. Spawns a *fifth* agent on a new branch.
- **12:00** — Lunch. Comes back to figure out which finished, which are blocked, which spent $4 on nothing.
- **13:00–17:00** — Repeats. Focus work fails because agents interrupt.
- **17:00–19:00** — Keeps shipping or moonlights on the side project. Same loop.
- **22:30** — Sometimes reopens the laptop to check if the overnight refactor finished.

**Tools they use.** macOS (Apple Silicon). iTerm2 or Ghostty. VS Code or Cursor (often both). Raycast. 1Password CLI. GitHub, Linear/Notion, Slack. Arc/Chrome with 80 tabs. tmux for the older ones.

**AI tools they pay for.** Claude Pro/Max ($20–200/mo) or Claude Code on API. Cursor Pro or Windsurf. Often ChatGPT Plus. Sometimes Codex CLI. Total: $50–500/mo. Not price sensitive on quality; very sensitive on "yet another subscription doing 30% of what I already pay for."

**Budget authority.** For themselves, total — under $50/mo is a yes if it saves an hour a month. Corporate-card under $30/mo: Slack DM the EM, not procurement.

**Where they hang out.** **Subreddits:** r/ClaudeAI, r/ChatGPTCoding, r/cursor, r/SideProject, r/indiehackers. **Discords:** Claude Developers, Cursor Community, Indie Hackers, latent.space. **Twitter/X:** @swyx, @karpathy, @theo, @levelsio, @t3dotgg, @rauchg, @dhh, @simonw. Reads HN every morning. **Newsletters:** Latent Space, Pragmatic Engineer, TLDR AI.

**What they tell other devs.** "I have five Claude Codes going and keep losing track of which window is which." "Lost 20 minutes because one was stuck on a y/n prompt." "I need a damn dashboard." "Cmux is sick but I still need VS Code open next to it." "I want to know how much I'm spending *while* it's spending it."

**Finding 20 next week.** Search Twitter for `"claude code" parallel` (last 30 days); DM the founders/builders. Show HN preview. Claude Developers Discord #show-and-tell. Cold DM recent cmux and Crystal contributors.

## 2. Anti-ICP (who this is NOT for)

- **Solo single-project hobbyist** — one repo, one agent; the alt-tab problem doesn't exist.
- **Junior dev learning fundamentals** — needs a real IDE with debugger and LSP, not a supervisor.
- **Enterprise platform / DevEx team buyer** — wants SSO, SOC2, on-prem; we're a single-user Mac app.
- **Mobile-only dev (Xcode / Android Studio)** — workflow is platform IDEs and simulators, not CLI agents.
- **Non-coder PM / designer vibe-coding landing pages** — supervisor framing assumes diffs, branches, worktrees.
- **Security-paranoid org forbidding LLM egress** — we summarize terminal output via Haiku; non-starter.
- **Windows or Linux developer (today)** — macOS-first v1. Be honest.
- **Cursor power user who runs one agent at a time** — Cursor's inline agent is enough; supervisor is overkill.

## 3. Positioning statement

**Variant A (chosen).**
> For senior developers who run **multiple Claude Code agents in parallel** (across multiple projects, or many branches in one), **baton** is a **parallel-agent supervisor** giving you one radar of every agent's status, cost, and task — plus an in-app diff/editor/git pane to review and intervene without leaving — **unlike cmux** (terminal-only, no editor) **or Conductor** (one workspace at a time).

**Variant B.**
> For indie hackers and senior engineers shipping multiple projects with Claude Code, baton is a Mission Control for AI agents that ends the alt-tab loop — unlike VS Code, which has no notion of "the other agent in the other window."

**Variant C.**
> For developers who delegate work to many AI coding sessions, baton is a multi-agent IDE that supervises every agent across every project — unlike Cursor, which assumes one agent, one window, one task at a time.

**Pick: A.** Names the category, the wedge, and disqualifies the two real competitors by their actual shortfall. B is tweet-good but vague on category. C is too close to "Cursor competitor" — exactly the framing we won't take.

## 4. Category

**Claim: parallel-agent supervisor.**

Rejected: *multi-agent IDE* (drags us into the Cursor/Zed editor fight we lose), *AI agent dashboard* (sounds like ops/telemetry), *agent terminal manager* (cmux's lane), *parallel-coding workspace* (Conductor's lane; loses the radar hook).

**Coin: parallel-agent supervisor** (short: *agent supervisor*). *Supervisor* is load-bearing — you're the boss, agents are workers, the tool surfaces what needs attention. *Parallel* says this isn't 1:1 like Cursor.

**Why we can win it.** No one's planted a flag here. cmux brands as "terminal for AI"; Conductor as "workspace"; Crystal called itself "session manager" and walked away. The supervisor framing maps to how the ICP already describes the problem ("I need a damn dashboard") and is defensible — it implies LLM summaries, HITL approvals, and cost caps, none of which fit editor or workspace categories cleanly.

## 5. Competitive narrative

| Capability | **baton** | cmux | Conductor | Crystal/Nimbalyst | VS Code + CC CLI | Cursor | Windsurf |
|---|---|---|---|---|---|---|---|
| Multi-project at once | Yes | Yes | Partial | One | Yes (N windows) | One | One |
| Cross-project agent radar | **Yes** | Single-project | No | No | No | No | No |
| LLM-summarized status | **Yes** | No (badges) | No | No | No | No | No |
| Worktree-per-agent | Yes | Yes | Yes | Yes | Manual | No | No |
| HITL approval pattern | Yes (semaphore) | Yes (Feed) | Partial | No | CLI prompt | N/A | N/A |
| Editor included | Yes (Monaco, no LSP) | No | Yes | Yes | Full VS Code | Full | Full |
| Cost visibility | **Yes** | No | No (top complaint) | No | No | Partial | Partial |
| Free / paid | TBD freemium | Free | Paid | Free→deprecated | Free | Paid | Paid |
| OSS / closed | TBD | OSS | Closed | Mixed | Mixed | Closed | Closed |

**vs cmux.** Pick baton to review diffs, edit, and run git ops without leaving — and for LLM summaries, not just badges. Pick cmux if you live in the terminal and don't mind VS Code beside it.

**vs Conductor.** Pick baton for *multiple projects* concurrently and cost visibility. Pick Conductor if you live in one repo and want polished Mac UX.

**vs Crystal / Nimbalyst.** Crystal is deprecated. Pick baton for what Crystal was, with lessons learned (panels-from-day-1, main-process notifications, cost visibility, cross-project radar). Pick Nimbalyst if your workflow is AI-editing markdown/mockups, not supervising code agents.

**vs VS Code + CC CLI.** Pick baton the moment you have ≥3 agents. Stay with the status quo if you only run one.

**vs Cursor / Windsurf.** Not competitors — *upstream*. Use baton alongside Cursor: baton manages the fleet, Cursor for deep single-file co-piloting.

**When NOT to pick baton.** Windows/Linux; one agent at a time; need full IDE (LSP, debugger); security policy forbids cloud summarizer.

## 6. Top 3 messages (value props)

### Message 1 — "See every agent at once."
One window, one radar, every agent across every project. Status, summary, branch, cost — on one strip at the top. No more alt-tabbing through six VS Code windows to find the stuck one.

**Unfair claim:** the only supervisor that radars **across projects, not just panes in one project**. cmux and Conductor are one-workspace each; we span all of them.

### Message 2 — "Know what each agent is doing without reading the terminal."
Every session gets a one-line LLM summary that updates as the agent works. "Refactoring auth module." "Waiting on permission to `rm -rf node_modules`." "Tests passing, opening PR." Glance; don't read. Haiku-powered, ≤$0.05/hour per active agent.

**Unfair claim:** the only supervisor with **LLM-generated summary-line status** — not just badges or hook signals. cmux shows a colored ring; we show the sentence.

### Message 3 — "Review and intervene without leaving."
File tree, Monaco editor, side-by-side diff, basic git, and inline-comment-to-agent — in the same window as the agent terminal. No more "the agent finished; now let me open VS Code to see the diff."

**Unfair claim:** the only tool with **a cross-project radar AND** in-app editor + diff + git. cmux has the radar, no editor; Conductor has the editor, one workspace.

## 7. Launch hook (HN / Twitter)

**Draft 1.** *Show HN: baton — Mission Control for your parallel Claude Code agents.*

**Draft 2.** *Show HN: baton — stop alt-tabbing through six VS Code windows to babysit AI agents.*

**Draft 3.** *Show HN: baton — one radar for every AI coding agent across every project.*

**Pick: Draft 3.** Concrete (radar, every project), specific (AI coding agent), no metaphor that needs explaining. Draft 1's "Mission Control" doesn't say what the product *is*. Draft 2 is the most HN-voice but leads with pain, not product — risk is people upvote, scroll past, don't try it.

## 8. Tagline candidates (5)

1. **"Supervise the agents. Ship the code."** — Names the role and the outcome. Punchy verbs.
2. **"Every agent. Every project. One radar."** — Hits the three-part wedge. Rule of threes. Imageable.
3. **"Stop polling. Start shipping."** — Calls out the actual time-waste loop in the ICP's day.
4. **"Your AI agents work. You watch the radar."** — Splits labor explicitly; reinforces supervisor framing; echoes "24-hour coding."
5. **"Mission Control for AI coding agents."** — Familiar metaphor, instantly intelligible to HN.

Lead with **#2** on the landing page; **#5** in press/podcast quotes.

## 9. Naming review

**baton — pros.** Short, four characters. Implies "24-hour coding" (agents work while you sleep). Numerals stand out among *Cursor / Cline / Aider / Codex*.

**baton — cons.** Pronunciation ambiguous ("twenty-four-code" vs "two-four"). SEO collides with random repos and "Section 24 code" legal results. Digit-leading breaks package/import conventions. "24" carries off-brand associations (TV show, McLaren, Kobe). `baton.com` likely parked; `baton.ai` realistic. Mistype risk: `24-code`, `baton`, `twentyfourcode`.

**Alternatives.**

1. **Helm** — evocative ("at the helm of your fleet"); maps to supervisor framing. Collides hard with Kubernetes Helm-chart. **Risk: SEO confusion.**
2. **Bridge** — ship's/command bridge. Same metaphor, easier to pronounce. `usebridge` / `agentbridge` plausible.
3. **Foreman** — names the role exactly. Mild collision with the Procfile tool. Strong vibe, slightly blue-collar in a good way.
4. **AgentRadar / CodeRadar** — uses our own central metaphor. Memorable; modifier needed because "Radar" is over-claimed.

**Recommendation.** Ship the beta as **baton** — renaming mid-build costs more than the cons warrant. Before public launch, pressure-test **Helm** and **Foreman** with 20 ICP interviews. If neither lands, keep baton and own the pronunciation ("twenty-four code, like 24/7"). Categories beat names.

## 10. Pricing posture

**Posture: free local app, paid cloud features, no enterprise SKU at launch.** The local supervisor — radar, editor, diffs, git, worktrees, hooks — should be free and ideally OSS: the ICP won't pay for "yet another menubar app," and OSS is how we beat Conductor on distribution and earn HN goodwill against cmux. The moat isn't the app; it's (a) summarizer quality/cadence and (b) cross-device sync of session state, cost rollups, and notifications — both cloud-shaped. Charge a flat monthly fee (not per-agent, which punishes the behavior we want) once a user crosses N concurrent agents or wants notifications on their phone. Distribution is our weakness, not monetization — give the supervisor away, build the install base, then sell sync, team HITL queues, and a Codex/Gemini backend that just works. Defer enterprise until a real buyer asks twice.
