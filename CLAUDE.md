@BRIEF.md
@AGENTS.md

# Working rules

- Read BRIEF.md and AGENTS.md first. AGENTS.md comes from Mastercard's AP4M kit; if it is missing, ask for it before writing payment code.
- Read everything in packages/ap4m/ before writing any payment code. Never guess the AP4M API.
- Never print, log or commit anything from .env. Testnet wallets only.
- Follow the build tiers in BRIEF.md section 14 in order. Finish and demo each tier before starting the next, and stop to let me confirm.
- Never fake or mock a demo step that judges will see as live; cut scope instead and say what was cut.
- Commit after each working tier.
