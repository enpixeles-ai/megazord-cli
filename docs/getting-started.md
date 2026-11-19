# Getting started

## 1. Prerequisites

- **Node 18+**
- At least **two** of these CLIs, installed and logged in:

| Zord | Install | Log in |
|------|---------|--------|
| 🦖 Claude *(referee — recommended)* | `npm i -g @anthropic-ai/claude-code` | run `claude` |
| 🐘 Codex | `npm i -g @openai/codex` | run `codex` |
| 🛡️ Kimi | `npm i -g @moonshot-ai/kimi-code` | `kimi login` |
| 🦅 Gemini | `npm i -g @google/gemini-cli` | run `gemini` or use authenticated `agy` |
| Saberdiente | Z.AI Coding Plan | GLM debate, optionally builds via a configured CLI |
| Dragonzord | DeepSeek via OpenCode | Isolated read-only debate and approved edits |

All six are optional. A council needs two responding voices. Run `megazord doctor` for local detection or `megazord doctor --vivo` to send a real request to each available provider. Chimerazord reviews the current tracked diff with the available specialties.

| Optional environment variable | Purpose |
|---|---|
| `MEGAZORD_CLAUDE_MODEL` | Claude model (default `opus`) |
| `MEGAZORD_GEMINI_MODEL` | Antigravity model (default `gemini-3.8-flash-high`) |
| `MEGAZORD_OPENCODE_BIN`, `MEGAZORD_DEEPSEEK_MODEL` | OpenCode executable and model (defaults: `opencode`, `opencode/deepseek-v4.1-flash-free`) |
| `ZAI_API_KEY` | Z.AI Coding Plan credential. Falls back to the ZCode coding-plan provider configuration. |
| `MEGAZORD_ZAI_MODEL`, `MEGAZORD_ZAI_MAX_TOKENS` | GLM model and response budget (defaults: `GLM-5.3`, 24000) |
| `MEGAZORD_ZAI_CLI` | Executable for a Claude Code instance configured for Z.AI. Enables editing. |
| `MEGAZORD_SUBAGENTES` | Additional Codex threads (default 0) |
| `MEGAZORD_KNOWLEDGE_CMD` | Optional executable taking the task as one argument. Its stdout becomes council evidence. Disable with `council-dev consensus "task" --no-knowledge`. |
| `MEGAZORD_LANG` | Output language, English by default or `es` for Spanish |


> Megazord uses whatever you're logged into. No API keys required if your CLIs use subscription auth.

## 2. Install

```bash
npm i -g megazord-cli
```

or from source:

```bash
git clone https://github.com/enpixeles-ai/megazord-cli
cd megazord-cli
./install.sh
```

## 3. Verify

```bash
megazord doctor
```

You should see each CLI reported `OK`. Anything missing just won't be used.

## 4. First run

Start read-only (no files touched):

```bash
cd some-project
megazord "what's the riskiest part of this codebase?"
```

When you're ready to let it build:

```bash
megazord mission "add a health-check endpoint with a test"
```

Read the minutes of what just happened:

```bash
megazord session          # who proposed what, the final directive
megazord cost             # token magnitude
```

## Optional: Telegram recaps

Get a summary of each council on your phone:

```bash
export TELEGRAM_BOT_TOKEN=123456:ABC...     # your bot token
export TELEGRAM_CHAT_ID=987654321           # your chat id
```

(or put the token in `~/.config/megazord/telegram-token`). If either is missing, notifications are silently skipped.

## Optional: watch them work live

```bash
megazord-chamber          # simulated 2x2 (great for a quick demo)
```

For a real remote server, copy `scripts/power-chamber-vps.template`, set your host, and run it.
