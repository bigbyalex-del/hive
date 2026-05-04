# Hive — YourAIHive

Personal multi-agent app-building tool. 1 Manager + 8 Workers in a spatial dashboard. Each agent's model is swappable between Anthropic, OpenAI, and Google.

## First-time setup

```powershell
cd C:\Users\Fusion\hive
copy .env.example .env
# open .env and paste your keys
```

Required in `.env`:
- `ANTHROPIC_API_KEY` — get from https://console.anthropic.com
- `OPENAI_API_KEY` — only needed if you swap any agent to a GPT model

## Run

```powershell
npm start
```

That builds TypeScript and launches the Electron window.

Type a task in the input bar (try: `create hello.txt with the words "hello hive"`) and press Enter. The Manager (center) decomposes it, dispatches to Worker 1, and the file appears in `worktrees/wt-1/`.

## Switch models per agent

Click **⚙ models** in the top-right. Pick provider + model for any of M / W1–W8. Saved across restarts.

## Project layout

See `NOTES.md` for the full design, roadmap, and decisions log.

## Roadmap

- v0.1 — Manager + W1 round-trip ← *you are here*
- v0.2 — All 8 workers, git worktrees, SQLite state
- v0.3 — Voice (Whisper STT + TTS, push-to-talk)
- v0.4 — Live preview pane + Playwright self-test loop
- v0.5 — Stack templates + codebase memory
- v1.0 — Packaged `.exe` installer
