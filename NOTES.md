# HIVE — Project Notes

> Personal multi-agent app-building tool. 1 Manager + 8 Workers in a 3×3 spatial dashboard. Voice-driven. Built for shipping apps faster (FXV / Maths App / future), possibly productized later.

Started 2026-05-04. Owner: Alex.

---

## 🌅 Next Session — pick up here (2026-05-05)

### 0. Verify state still works (2 min)

```powershell
hive
```

Ask Manager: *"what was the last thing we did?"* — should pull from SQLite. If yes, persistence intact.

### 1. The blocker list — FXV-safe gate (3 days work)

**Hive should NOT touch FXV until items 1–4 land.** Greenfield only (`/tmp/...`, demo apps, scratch projects) for now.

| # | Build | Hours | Why critical |
|---|---|---|---|
| 1 | Specialised roles + exclusive file ownership | 5 | Tonight's site-build bug — workers overwrote each other's styles.css. Without file claims, FXV use = silent data loss. |
| 2 | Real git per worktree (auto init/branch/commit/diff) | 4 | No way to review or rollback worker changes today. Non-negotiable for production code. |
| 3 | Reviewer role (typecheck/lint/style gate) | 3 | Workers ship direct → no quality control. FXV needs every output verified. |
| 4 | Cost cap + worker timeout + 429 backoff | done tonight (`f2b3624`) | ✅ Shipped: 5-min worker timeout, expo-backoff on 429s, 5M-token-per-run cap |
| 5 | Codebase RAG on FXV (vector index) | 4 | Without it workers violate FXV conventions. Useful, not blocking. |
| 6 | Personal preference memory (port from Claude Code) | 3 | Brand rules auto-injected (no emoji, gradient on data viz only, etc) instead of typed each prompt. |

### 2. The role org-chart — 12 starter roles

40 possible roles documented; ship these 12 in this order:

| # | Role | Status | Hours |
|---|---|---|---|
| 1 | **Coordinator** (= Manager) | ✅ done | — |
| 2 | **Builder** (= Worker) | ✅ done | — |
| 3 | **Scout** — codebase mapper, Read+Glob+Grep only | TODO | 2 |
| 4 | **Reviewer** — typecheck/lint/style gate, Read+Run+Fetch | TODO | 3 |
| 5 | **Tester** — writes + runs tests until green | TODO | 2 |
| 6 | **Spec Interviewer** — 30-90s voice intake before dispatch | TODO | 2 |
| 7 | **Cost Sentinel** (always-on) — watches spend; basic shipped | partial | 2 |
| 8 | **Recapper** — nightly: commits + audit → recap file | TODO | 2 |
| 9 | **Social Media Manager** — drafts FXV/DSA-voiced posts | TODO | 3 |
| 10 | **Outreach Specialist** — pre-qualified-leads pipeline (designed §15) | TODO | 4 |
| 11 | **Deployer** — handles OTA/release on command | TODO | 2 |
| 12 | **Sentry Watcher** (always-on) — triages errors → dispatches fixes | TODO | 4 |

**Roles architecture:** each role = a worker config in `src/main/roles/<name>.ts` with `{systemPrompt, tools, defaultModel, triggers}`. Coordinator picks role *and* model per subtask.

### 3. Recommended first build tomorrow (~7 hr, the BridgeMind playbook)

Ship **Spec Interviewer + Scout + Reviewer** as one cohesive change:
- Spec Interviewer → unambiguous brief
- Scout → codebase context before any Build
- Reviewer → quality gate after every Build

Together they fix tonight's class of bug AND make every run more reliable. After that, layer Tester / Recapper / Social / Outreach over the next sessions.

### 4. The other 28 roles documented (build later, not tomorrow)

Engineering: Refactorer, DevOps, Security Auditor, Performance Auditor, UI Designer, UX Designer, Spec Writer, Product Manager, User Researcher.
Content: Copywriter, SEO Specialist, Newsletter Writer, Video Scriptwriter, Community Manager.
Sales: Lead Researcher, Customer Success, Reply Drafter.
Ops: Health Monitor, Data Analyst, Forecaster.
Legal: App Store Compliance, GDPR/Privacy, Legal Reviewer, Bookkeeper.
Personal: Calendar Manager, Email Triage, Research Assistant, Note Synthesizer.
Strategic: Roadmap Planner, Competitor Watcher, Decision Documenter.

### 5. 2026-05-04 commits on GitHub (`bigbyalex-del/hive` main)

| # | Commit | Added |
|---|---|---|
| 1 | `a46a0cd` | v0.3 — Run sandbox (allowlist + child_process + audit) |
| 2 | `cbf5abe` | v0.4 — MCP support (filesystem server, tool wrapping) |
| 3 | `bb6f1a1` | Web Fetch via MCP attempt (replaced — Python-only) |
| 4 | `88144ac` | v0.5 — Native Fetch tool (https + domain allowlist) |
| 5 | `78b91a6` | v0.6 — SQLite persistence (sql.js, Manager memory) |
| 6 | `caf06ad` | sql.js locateFile fix |
| 7 | `1a4eabe` | NOTES — first "Next Session" pickup brief |
| 8 | `665ab93` | Fetch allowlist: research/academic publishers |
| 9 | `1554877` | Fetch allowlist: + researchgate, europepmc, sage |
| 10 | `f2b3624` | Safety: worker timeout + 429 backoff + run token cap |
| 11 | (this commit) | Role inventory + tomorrow's blocker list |

### 6. Known limitations carried into tomorrow

- **MCP fs rooted at `worktrees/` only** — workers can't reach project root files (NOTES.md etc). Add a project-files MCP server when needed, locked to specific paths.
- **Manager occasionally still chats when it should dispatch** — system prompt tightened tonight, watch for regressions.
- **No retry on Run timeouts** — only on 429s.
- **Audit log only covers Run + MCP** — Read/Write/Edit not yet logged.
- **`hive` launcher skips build** — if you edit code and don't see changes, run `hive-build` instead.
- **Dispatch history is per-run, not per-project** — when multi-project switching ships, namespace by project.

### 7. Launcher commands (reminder)

| Command | Behaviour |
|---|---|
| `hive` | instant launch, no rebuild |
| `hive-build` | rebuild TS first, then launch (use after editing code) |

---

## 1. One-liner

**"Talk to a manager. Watch eight agents build."**

You speak a feature into the mic. A Product agent interviews you for clarity. The Manager decomposes the work, dispatches to 8 workers in parallel git worktrees, and they ship. Live browser/device preview confirms it actually runs.

---

## 2. Why build it (vs. Cursor / Devin / Factory)

- **Cursor** is a chat-on-a-file. Hive is *task-on-a-product*.
- **Devin** is autonomous but opaque. Hive is autonomous *and* spatially legible — you can glance at all 9 agents at once.
- **Factory / Cognition** target enterprise teams. Hive targets the solo builder running 3 projects.
- The novel wedge: **voice + 3×3 grid + live preview pane**. Nobody else combines these.

---

## 3. Topology

```
┌─────┬─────┬─────┐
│ W1  │ W2  │ W3  │
├─────┼─────┼─────┤
│ W4  │  M  │ W5  │
├─────┼─────┼─────┤
│ W6  │ W7  │ W8  │
└─────┴─────┴─────┘
```

- **M (Manager)** — center. Decomposes user prompt → DAG of subtasks. Assigns role hats. Dispatches. Resolves conflicts. Aggregates. **Never edits code.**
- **W1–W8 (Workers)** — generalists. Each owns its own git worktree + branch. Receive task + role hat (coder/reviewer/researcher/tester/designer/deployer/etc.). Report back. Idle.
- **Center swap:** Manager panel can be replaced live with the **Preview Pane** (running app / mobile mirror) at user's request. The Manager state moves to a thin top strip when this happens.

---

## 4. Stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron** | Mic via `MediaRecorder`; reuses HTML mockup; no Rust toolchain (vs Tauri) |
| Renderer | HTML + CSS + vanilla JS (later: React if needed) | Mockup already exists, drop in |
| Main | **Node 20+** | Claude Agent SDK is first-class TS |
| Agents | **`@anthropic-ai/claude-agent-sdk`** | Direct, well-supported |
| State | **SQLite** (`better-sqlite3`) | Single file, no server, durable |
| Isolation | **git worktrees** | One per worker, branch-per-task |
| STT | **OpenAI Whisper API** | $0.006/min, gold-standard accuracy |
| TTS | **OpenAI TTS** | matches the STT pipe |
| Browser test | **Playwright** | Real Chromium, screenshots, assertions |
| Vector store | **sqlite-vss** or **LanceDB** (TBD) | Local-first, no extra service |
| Mobile preview | Expo dev-client + USB/LAN bridge | For FXV-class projects |
| Distribution | **electron-builder** → `Hive-Setup.exe` | Standard Windows install |

**Models (mixed by role):**
- Manager → **Opus 4.7** (`claude-opus-4-7`) — orchestration is the highest-leverage thinking
- Workers → **Sonnet 4.6** (`claude-sonnet-4-6`) — bulk coding, good ratio of cost/quality
- Reviewer/cheap utility → **Haiku 4.5** (`claude-haiku-4-5-20251001`)
- Vision (sketch→code) → **Sonnet 4.6**
- Whisper STT / TTS → OpenAI

---

## 5. v1 feature set (locked — these compound into the demo)

1. **Spec Interview agent** — voice-driven Product agent. Before the Manager dispatches anything, this agent interviews the user for 30-90s until the spec is unambiguous. Output: user stories + acceptance criteria + edge cases + out-of-scope. Kills ~80% of "agent went off-piste" outcomes.

2. **Live Preview pane** — center column swaps from Manager dashboard to the running app. Hot-reload from worker edits. For mobile, a QR streams Expo to the user's phone *and* mirrors it in the pane.

3. **Self-testing browser loop** — every worker that touches UI runs Playwright on its own output: navigates the user journey, screenshots, asserts. Reports back with pass/fail + screenshot. Closes the "tests pass but UI broken" gap.

4. **Stack Templates** — `hive new <template>` scaffolds a full app in ~60s with all glue wired. Initial templates:
   - `expo-paywall` — Expo + RevenueCat + Supabase + Sentry + EAS (FXV stack)
   - `next-saas` — Next.js + Stripe + Supabase + Vercel
   - `static-site` — HTML + Tailwind + Cloudflare Pages
   - `web-game` — Phaser/Pixi + Vercel (Maths App style)

5. **Codebase memory** — embedded vector index of the repo's code + past decisions + past bugs. Every worker queries before starting a task. Persists across sessions.

---

## 6. Backlog (Tier 2/3 — not v1)

- **Voice diff review** — workers' diffs surface in the pane; user voice-approves/rejects/redirects; Manager re-dispatches.
- **Deploy worker** — permanent 9th role; ships to staging on every approved merge; posts URL.
- **Live USB/LAN device push (FXV-specific)** — JS bundle pushed direct to connected iPhone, ~2s reload. Replaces the EAS update wait.
- **Sketch / Figma → code** — vision worker; drag a frame, get React.
- **Persona user-testing** — synthetic users with personas run flows every N min, report friction.
- **Cost governor** — hard token / $ ceilings per task; Manager kills runaway loops.
- **Time machine** — every Manager decision checkpointed; rewind N steps and re-run.
- **Visual regression** — screenshot diff on every worker commit; flags CSS regressions.
- **Mixed-provider fallback** — if Anthropic rate-limits, fall back to OpenAI/Gemini per worker.
- **Multi-screen** — Manager on monitor A, worker logs on monitor B.

---

## 7. UI

Mockup: `C:\Users\Fusion\multi-agent-mockup.html` (already approved).

- 3×3 grid, Manager center with purple gradient + glow halo.
- Each cell shows: agent ID, status dot (idle/working/done/error/review), current task, last 3 log lines, worktree, tokens, elapsed.
- Top bar: overall task, runtime, total cost, total tokens.
- Bottom bar: keybindings.
- Center swap: Manager ↔ Live Preview (via `M` key or voice "show preview").
- Pulse animation on `working` dot.

**Keybindings (current spec):**
- `1`–`8` — focus a worker, expand log full-screen
- `M` — focus Manager
- `P` — pause all
- `R` — resume
- `L` — tail logs of focused agent
- `space` — push-to-talk (hold)
- `esc` — back to grid
- `Q` — quit (kills sessions, cleans worktrees)

---

## 8. Voice flow

1. User holds **space** or says **"Hey Hive"**.
2. `MediaRecorder` captures audio → buffered to Whisper API on release.
3. Transcript routed: if no active task, → Spec Interview agent. If active task, → Manager as a directive.
4. Manager (or Spec agent) replies via TTS through speakers AND prints in the dashboard.
5. Optional: cheaper Web Speech API path for low-stakes interactions.

---

## 9. File layout (when scaffolded)

```
C:\Users\Fusion\hive\
├── NOTES.md                    # this file
├── package.json
├── tsconfig.json
├── electron-builder.yml
├── .env.example                # ANTHROPIC_API_KEY, OPENAI_API_KEY
├── src/
│   ├── main/                   # Electron main process
│   │   ├── index.ts            # app entry
│   │   ├── orchestrator.ts     # task queue + lifecycle
│   │   ├── manager.ts          # Manager agent wrapper
│   │   ├── worker.ts           # Worker agent wrapper
│   │   ├── spec-interview.ts   # Product agent
│   │   ├── voice.ts            # Whisper STT + TTS
│   │   ├── preview.ts          # Playwright + Expo bridge
│   │   ├── memory.ts           # vector store
│   │   ├── worktree.ts         # git worktree helpers
│   │   ├── store.ts            # SQLite schema + accessors
│   │   └── ipc.ts              # main↔renderer messages
│   ├── renderer/               # Electron renderer (UI)
│   │   ├── index.html          # the dashboard (from mockup)
│   │   ├── app.js              # cell updates + keybindings
│   │   └── styles.css
│   └── shared/
│       └── types.ts            # IPC types
├── templates/                  # `hive new <template>` sources
│   ├── expo-paywall/
│   ├── next-saas/
│   ├── static-site/
│   └── web-game/
└── worktrees/                  # per-worker checkouts (gitignored)
    ├── wt-1/
    └── …
```

---

## 10. Roadmap

**v0.1 — bones (1–2 days)**
- Electron window opens with mockup as static UI
- Single Manager + single Worker, both wired to Agent SDK
- Worker writes a file, Manager reports done
- No voice, no preview, no templates

**v0.2 — full grid (2–3 days)**
- All 8 workers spawning in worktrees
- Manager DAG decomposition
- SQLite state, restart-resilient
- Cell statuses live in UI

**v0.3 — voice (1–2 days)**
- Push-to-talk → Whisper → routing
- TTS replies
- Spec Interview agent

**v0.4 — preview + tests (2 days)**
- Center swap to live browser pane
- Worker-driven Playwright loop with screenshots
- Pass/fail surfaced in cell

**v0.5 — templates + memory (2 days)**
- 4 starter templates working with `hive new`
- Vector store of codebase + decisions
- Workers query memory before starting

**v1.0 — package**
- electron-builder → signed `Hive-Setup.exe`
- Start-menu shortcut, desktop icon
- README + 90s demo video

**Total greenfield estimate:** ~10–12 focused days. Probably 3–4 weeks calendar time alongside FXV.

---

## 11. Open questions

- **Vector store:** sqlite-vss (zero-deps) vs LanceDB (richer) — decide at v0.5.
- **Worker model concurrency:** can all 8 Sonnet sessions run simultaneously without rate-limit? Test early. Fallback: queue 4-at-a-time.
- **Worktree cleanup policy:** keep N most recent task branches, or wipe on Manager merge? Lean toward wipe-on-merge with explicit "keep" flag.
- **TTS interruption:** if Manager is mid-speak and user starts a new mic input, cut TTS or queue? Cut.
- **Multi-project:** does one Hive instance handle multiple repos (FXV + Maths in parallel) or one-repo-per-instance? v1 = one-repo. Multi-project is a v2 question.
- **Conflict resolution policy:** when 2 workers touch the same file — sequential, merge, or split? v1 = Manager forces sequential by default; advanced merge is v2.
- **Cost guardrails:** soft alert at $5/task, hard kill at $20? Configurable.

---

## 12. Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-05-04 | Name = HIVE | Queen + workers metaphor, honeycomb 3×3 grid, ownable as `hive` CLI |
| 2026-05-04 | Electron over Ink | Mic input requires browser APIs |
| 2026-05-04 | Electron over Tauri | No Rust toolchain needed; size doesn't matter for personal use |
| 2026-05-04 | 8 fixed workers (not dynamic pool) | Matches screen layout exactly; predictable cost; warm sessions |
| 2026-05-04 | Manager never edits code | Keeps context window small, decisions auditable |
| 2026-05-04 | v1 = Spec / Preview / Test Loop / Templates / Memory | These five compound into the viral demo |
| 2026-05-04 | Mixed models (Opus M / Sonnet W / Haiku util) | 3-5x cost reduction with marginal quality drop |
| 2026-05-04 | Whisper for STT (not Web Speech) | Accuracy matters when transcript becomes a task |

---

## 13. Naming conventions

- Workers identified by integer ID `W1`–`W8` plus active role hat (`W3:reviewer`).
- Worktree dirs: `worktrees/wt-{id}` (e.g. `wt-3`).
- Branches: `hive/{taskId}-{slug}` (e.g. `hive/T-014-dark-mode`).
- Tasks: `T-{seq}` (zero-padded to 3 digits, monotonic).
- Templates: kebab-case (`expo-paywall`).
- Logs: one JSON-lines file per agent at `~/.hive/logs/{date}/{agent}.jsonl`.

---

## 14. How to make money with Hive

Two parallel paths: **(a) use Hive to deliver paid services** (fastest cash) and **(b) eventually productise Hive itself** (slower, bigger ceiling).

### Tier 1 — earnable this week

**1. Solo agency / freelance "fix anything" wrap (highest ROI today)**
- Pitch: "£300 to fix any 3 things on your site this week" to small-business owners
- Hive's edge: Watch + voice + screenshot + agent fixes = 2-hour delivery on what agencies take 2 weeks
- Find clients: Twitter complaints ("my shopify is broken"), Upwork, local FB groups
- 5 clients × £300/wk = ~£6k/mo
- Side benefit: every fix = case-study content for marketing

**2. Bulk content / SEO articles**
- Pitch SEO agencies: "50 articles/week, £40 each"
- Needs parallel fan-out (in v0.3 / shipping next)
- 1 agency client = £2-5k/mo, repeatable

### Tier 2 — earnable this month

**3. Visual UX/UI audits** — £200 site audits (Watch mode → screenshot → agent identifies issues → Loom + PDF report). Upsell £800 fix package.

**4. Hive Stacks marketplace (passive)** — paid `hive new <template>` packs at £29 each (fxv-style, next-stripe, shopify-theme, astro-blog, chrome-extension). Needs stack templates feature (v0.5).

### Tier 3 — earnable this quarter

**5. Build with Hive, sell the apps** — FXV + Maths App + 3 more. Hive is leverage; apps are products. Highest ceiling long-term.

**6. Niche productisation** — "Hive for Shopify" / "Hive for WordPress" / "Hive for Webflow" at £49/mo subscription. 100 users = £5k MRR. 6-12 months of focused work.

**7. Content / YouTube** — "I built X with 8 AI agents in N hours" videos. Sponsorships, course sales.

### Recommended sequence

Week 1-4: Tier 1 freelance wrap → £1-2k revenue, validates workflow + makes content.
Week 2 (in parallel): parallel fan-out shipped → bulk content unlocked, pitch one SEO agency.
Week 4-8: First Hive Stacks template pack on Gumroad.
Continuously: ship FXV + Maths App features faster.

**The honest truth:** today, the fastest path to revenue isn't selling Hive — it's using Hive to sell *outcomes* (fixes, articles, audits, shipped apps). Productisation comes after the workflow has been validated on real client work.

---

## 15. Auto-outreach pipeline (lead-gen agent)

Goal: agent finds prospects + drafts personalised outreach automatically. Alex reviews + sends. Eventually fully autonomous when reputation is warm.

### Architecture

```
Cron (e.g. 9am daily) →
  Manager dispatches 4 subtasks in parallel:
    Hunter (W1) — scrape Twitter/X for last-24h complaints (shopify broken, site slow, stripe issue, etc.)
    Researcher (W2) — for each lead, find website + tech stack + decision-maker email
    Outreach (W3) — draft a personalised pitch referencing their tweet
    Tracker (W4) — check Resend/Gmail for replies; flag for follow-up
  Output: CSV (lead, tweet_url, drafted_email, contact_email)
  Human gate: Alex reviews 10 min/day → presses send in Resend
```

### Lead sources (ranked for fix-it freelance)

🟢 **Pre-qualified — already complaining**
- Twitter / X searches: "my shopify is broken" / "site slow" / "stripe stopped working" — 5-15% reply rate
- Reddit r/Shopify, r/webdev, r/smallbusiness
- Indie Hackers forum
- Job boards hiring "shopify expert" / "web dev"

🟡 **Cold but targeted**
- Google Maps API — local businesses with poor websites (volume play)
- Companies House (UK) — new business filings

🔴 **Avoid** — generic LinkedIn cold scrapes (saturated, GDPR risk)

### Stack & cost

| Component | Tool | Cost |
|---|---|---|
| Twitter scrape | socialdata.tools | £30/mo |
| Email finder | Hunter.io free tier | £0 |
| Email send | Resend (3k/mo free) | £0 |
| Sending domain | `outreach.youraihive.com` (subdomain so main brand is protected) | included |
| DNS / domain | Cloudflare + Namecheap | ~£10/yr |
| Hive agents | Anthropic | ~£0.50/lead processed |
| **Total** | | **~£35/mo** |

### Realistic numbers

- 10 emails/day × 30 days = 300/mo
- Pre-qualified Twitter complaints: 8-15% reply → 30-45 replies/mo
- Cold lists: 1-3% reply → 3-9 replies/mo
- 20% replies → calls → 30% close → **5-10 paid clients/mo**
- At £300/job = **£1.5-3k/mo**

### UK legal reality

- B2B cold email is legal under "legitimate interest" basis IF:
  - professionally relevant
  - clear unsubscribe link
  - linked privacy policy
  - sender identified (full name + business address)
- B2C cold email almost always illegal (PECR consent requirement)
- **Don't use Gmail at scale** — account ban risk + main email reputation tanks
- **Use a sending subdomain** (`outreach.youraihive.com`) so blacklisting doesn't kill main domain
- **Throttle**: max ~30/day per inbox, randomised intervals, no weekends

### Build phases

**Phase 1 (~3 hrs in Hive)** — Hunter + Outreach drafting
- Twitter scrape via socialdata.tools (or free X tier first)
- Outreach worker drafts pitches
- Output CSV daily; Alex hand-sends top 5-10
- Goal: real reply data, validate offer/positioning

**Phase 2 (next week)** — Resend + auto-send with throttle
- Up to 30/day, randomised, M-F only
- Suppression list (don't email anyone twice in 30d)
- Bounce/spam handling

**Phase 3 (week 3+)** — Tracker
- Polls Gmail for replies
- Auto-drafts follow-up emails for Alex review
- Updates lead status in Hive UI

### Strong recommendation

**Semi-automated, not fully.** Don't have Hive press send. Reasons:
- Spam filters punish anything that looks automated
- One off-message blast = brand damage
- Legal: Alex is the sender, Alex should be in the loop
- Pattern recognition: which subject lines / openers actually work — only learn this with eyes-on review for first 2-3 weeks

After 2-3 weeks of CSV → manual send, remove the human gate.

### Open questions before building

- First lead source: Twitter complaints (preferred) vs Google Maps local businesses?
- First offer: "£300 to fix 3 things this week" or different?
- `outreach.youraihive.com` subdomain set up, or use Alex's existing email for v1?
- DSA disclosure: as a public DSA trader, may need careful wording so outreach doesn't conflict with publicly-listed signals work

---

## 16. How to sell Hive itself (later — not v1 concern)

Path D first (eat own dog food on FXV + Maths App). If 2-3 shipped apps later it still feels like a wedge:
- Niche it: **"Swarm for QA"** or **"Swarm for Migrations"** are the strongest paid-tool angles
- Open-core (free local, paid cloud) if community forms
- Avoid head-on Cursor/Devin fight

For now: **leverage tool, not product.** Revisit selling once Hive has shipped 3 apps for Alex.

---

## 15. Status

- [x] Mockup approved (HTML at `C:\Users\Fusion\multi-agent-mockup.html`)
- [x] Name + stack + v1 features locked
- [x] Project directory created (`C:\Users\Fusion\hive\`)
- [x] Notes written (this file)
- [ ] Memory entry added to `MEMORY.md`
- [ ] Awaiting "go" from Alex to scaffold `package.json` + Electron skeleton
- [ ] v0.1 — single Manager + single Worker round-trip
- [ ] v0.2 — full 8-worker grid
- [ ] v0.3 — voice
- [ ] v0.4 — preview + test loop
- [ ] v0.5 — templates + memory
- [ ] v1.0 — packaged installer
