Step back from the task for a moment. Maestro (a baton orchestrator) is asking each candidate session a **follow-up question**: looking at this entire conversation, is there **outstanding work you've implicitly committed to** that you could pick up right now without needing any new input from the user?

The point of this phase: every session has just told Maestro "I'm waiting on the user." Before Maestro accepts that, we want to double-check that nothing got dropped on the floor mid-conversation.

What counts as outstanding work:

- You said "I'll get back to that" / "let me revisit X later" / "circling back to Y" and never did.
- The user listed multiple things and you addressed only some of them.
- You created a TODO list mid-conversation and only checked off part of it.
- You noticed a bug, inconsistency, or follow-up you flagged but never fixed.
- A test you said you'd write but skipped to keep momentum.
- A cleanup, refactor, or doc update you punted from a previous turn.

What does NOT count:

- Things the user needs to answer or decide first — those are still `wait`.
- Net-new ideas you'd want to propose — those belong in the user's next prompt, not as outstanding work.
- "Could be improved" wishes you flagged but didn't commit to.
- Work that's clearly blocked on external dependencies (a CI run, a PR review, a user's local testing).

Voice: the `prompt` field is in the **user's voice**, directing you back to the unfinished piece. Same shape as the first round of this dialog.

- **DO**: "Pick up the TODO list — I notice steps 3 and 4 weren't checked off."
- **DO**: "Loop back and write that test for the parser error path you mentioned."
- **DO**: "Finish the doc update for the new auth flow — you started it but only got through the intro."
- **DON'T**: "Should I revisit the TODO list?"
- **DON'T**: "Want me to write that test?"

If there's NO real outstanding work — you wrapped cleanly, every task you took on is closed, every open question is genuinely on the user — return `wait`. That's the right answer; don't invent outstanding work to justify a resume.

Reply with ONLY this JSON — no markdown fence, no prose:

```
{
  "action": "resume" | "wait" | "defer",
  "prompt": "<user-voice directive pointing you back at outstanding work, OR empty string>",
  "rationale": "<one sentence: which outstanding piece this is and where it appears in the conversation>",
  "assumption": "<the one assumption about scope or priority that, if wrong, makes this resume the wrong move>",
  "if_wrong": "<what breaks + how to revert. ≤200 chars>",
  "reversibility_cost": "trivial" | "moderate" | "expensive",
  "confidence": "high" | "medium" | "low"
}
```

Confidence calibration:

- "high":   The outstanding work is explicit and recent (e.g., a literal TODO item you wrote and didn't check off, a "I'll do X next" you never delivered).
- "medium": You implicitly committed to it; reasonable to assume the user still wants it without checking first.
- "low":    Might be stale or out of scope — consider whether `wait` is actually right.
