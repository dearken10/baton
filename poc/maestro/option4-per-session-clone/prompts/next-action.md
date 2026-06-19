Step back from the task for a moment. Maestro (a baton orchestrator) is wiring a "fast-forward" between you and the user. Given everything in this conversation, **what would the user type as their next message to you to move this work forward?**

That's the `prompt` field below. It's in **the user's voice**, not yours — they're directing your next move with an answer, an instruction, or a confirmation.

- **DO** (user voice, directing you):
  - "Yes, the second option. Commit when tests pass."
  - "Add error handling to the parser and re-run the suite."
  - "That looks right. Push it."
  - "Debug the orchestrator — add a console.error after the sql call and find where the data is lost."
- **DON'T** (your voice, asking the user):
  - "Want me to add error handling?"
  - "Should I commit this or wait for you to test?"
  - "Two features are sitting uncommitted — what do you want me to do?"

If your last message asked the user a question — even implicitly — you do NOT know what their next message will be. Don't guess. The right action is `wait`.

Constraints:

- Pick ONE concrete next user message — not a list. The one you're highest-conviction about.
- Reversible: if the assumption behind that message is wrong, rollback should be cheap (git checkpoint + a corrective prompt at worst). If the only safe move is destructive and irreversible (rm, push, drop table, send email), the answer is almost certainly "wait" — the user needs to call the shot, not Maestro.
- Explicit assumption: name the SINGLE thing you're betting is true about user intent that could go wrong.
- Don't execute anything. Don't call tools. Just propose.

Reply with ONLY this JSON object — no markdown fence, no prose:

```
{
  "action": "resume" | "wait" | "defer",
  "prompt": "<the user's next message to you, in their voice. Empty string for wait/defer.>",
  "rationale": "<one sentence: why this is the best next user message>",
  "assumption": "<the one assumption about user intent that, if wrong, makes this prompt wrong>",
  "if_wrong": "<what breaks + how to revert. ≤200 chars>",
  "reversibility_cost": "trivial" | "moderate" | "expensive",
  "confidence": "high" | "medium" | "low"
}
```

Action semantics:

- "resume": Maestro will type the prompt into your terminal as if it came from the user. You'll receive it and continue.
- "wait":   Don't act. You're correctly blocked on the user's input (you asked a question, proposed options, or shipped work that needs human review). prompt = "".
- "defer":  This session shouldn't be touched right now (mid-tool-call, fresh session you haven't loaded, snoozed, etc.). prompt = "".

Confidence calibration:

- "high":   The user's next message is essentially determined by the conversation — they confirmed something, you have a clear mechanical next step to invoke, or they just answered a question and you're routing the work that answer unlocks.
- "medium": The user's likely next message is one of two interpretations and you're betting on the more probable one.
- "low":    Multiple equally-plausible user intents; reversibility matters more than throughput. Consider whether `wait` is actually right.
