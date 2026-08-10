# Maestro PoC

Spec lives in `PRD.md` §5 (F15.x). Only `option5-product-manager/`
remains — the other four exploratory prototypes (direct API,
Claude Code skill, master-mind session, per-session tick daemon)
have been removed now that the inline suggestion dock is the
production surface.

```
poc/maestro/
└── option5-product-manager/    fresh `claude -p` PM proposer
    ├── pm-propose.mjs            reads the target JSONL tail, fires the goal.md prompt
    ├── prompts/goal.md           the editable proposer prompt
    └── README.md                 how it plugs into MaestroSuggestionCard
```

The app calls `pm-propose.mjs` from `app/src/main/services/
maestroSuggestion.ts` whenever a session transitions running → idle
and the effective `maestroEnabled` flag is true; the returned
suggestion appears in `MaestroSuggestionCard` above the terminal
input.
