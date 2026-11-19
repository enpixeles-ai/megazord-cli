# Changelog

## 1.2.0 — 2026-11-19

Engine 0.12.0. Megazord grows from four to **six optional Zords**.

### New Zords
- 🦅 **Pterodactyl now runs on Google Antigravity** (`agy`). The Gemini CLI stays as a fallback.
- 🐯 **Saberdiente — Z.AI ZCode Coding Plan (GLM).** Debates through the Coding Plan API; builds bounded steps when `MEGAZORD_ZAI_CLI` points to a Claude Code instance configured for Z.AI.
- 🐉 **Dragonzord — DeepSeek via OpenCode** (free model). Read-only in the debate, isolated edits when building, no usable shell.

### New features
- **Availability-based councils:** only installed and signed-in Zords are called; two live voices are enough.
- **Chimerazord:** the available Zords become six simulated attackers on your own repo (AppSec, prompt injection, secrets, business logic, systemic failures, privacy), read only and defensive; a CISO consolidates one prioritized report.
- **`doctor --vivo`:** sends one real request to each Zord. Plain `doctor` now says "session not checked" instead of claiming a Zord works.
- **Codex sub-agent cap:** `MEGAZORD_SUBAGENTES` (default 0). Each sub-agent roughly doubles the input cost of a call.
- **Configurable models:** `MEGAZORD_CLAUDE_MODEL`, `MEGAZORD_GEMINI_MODEL`, `MEGAZORD_ZAI_MODEL`, `MEGAZORD_DEEPSEEK_MODEL`.
- **Optional knowledge step:** `MEGAZORD_KNOWLEDGE_CMD` feeds evidence to the council; `--no-knowledge` turns it off.
- Claude critiques without tools in round 2.

### Security fixes
- **OpenCode 2 ignores `OPENCODE_PERMISSION` silently.** Megazord now passes permissions inside `OPENCODE_CONFIG_CONTENT`, disables the project's own OpenCode config, runs `--standalone` and sets the working directory explicitly. Before this fix, a read-only debate could write files outside its folder.
