# Contributing to Megazord

Thanks for wanting to help! 🦖

## The lay of the land

- **`bin/council-dev.js`** — the whole engine. One dependency-free Node file. Adapters for each CLI, the debate/arbiter flow, the plan gate, parallel waves, verification, and the session/cost/telegram helpers all live here.
- **`scripts/`** — the friendly wrappers (`megazord`, the Power Chamber views, the demo animation).
- **`docs/`** — guides.

## Running the tests

```bash
node bin/council-dev.js selftest   # pure-logic asserts, spends nothing
```

Please keep `selftest` green and add asserts when you change core logic.

## Adding a new Zord (another CLI)

The adapter layer is small. In `bin/council-dev.js`:
1. Add a profile to `CLI_PROFILES`.
2. Add `xxxConfigured()` detection (how you know it's installed + authed).
3. Add `xxxPlan` / `xxxWrite` adapters (how to invoke it headless for read vs write).
4. Wire it into the roster.

Open a PR describing which CLI and how you tested it.

## Guidelines

- **No runtime dependencies** in the engine. Keeping it a single readable file is a feature.
- **Never commit secrets or personal data** (tokens, IPs, chat IDs). The engine reads those from environment variables.
- Match the existing style. Comments and user-facing output can be in English or Spanish; keep a file internally consistent.
- Small, focused PRs win.

## Reporting bugs

Open an issue with: what you ran, which Zords were online (`megazord doctor`), and the relevant slice of the transcript from `.council-dev/runs/`.
