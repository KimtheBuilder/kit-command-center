# KIT Command Center — Deploy Guide 🛠️

Your JARVIS-style business operating system. Plain Node.js — **no build step, no Docker, no tsx**. Same deploy pattern that worked for the KTB Agent Stack.

## 1. Push to GitHub (GitHub Desktop — the method that works)

1. In GitHub Desktop: **File → New Repository** → name it `kit-command-center`, pick a local folder.
2. In Terminal: `cp -R ~/Downloads/kit-command-center/* /path/to/your/local/repo/`
   (do NOT copy `node_modules` — it's already excluded by .gitignore)
3. In GitHub Desktop: commit → **Publish repository**.

## 2. Create the Render service

1. Render → **New → Web Service** → connect the `kit-command-center` repo.
2. Settings:
   - **Root Directory:** leave BLANK
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance:** free tier works for V1
3. Environment variables:
   - `MCP_PATH_TOKEN` = a long random string you invent, e.g. `ktb-kit-2026-secure-key-XXXX`
   - `ADMIN_KEY` = a second secret for the dashboard (the UI will prompt you for it once)
   - `DATA_DIR` = `/var/data` **only if** you add a persistent disk (recommended: Disks → Add Disk → mount path `/var/data`, 1 GB). Without a disk, data resets on redeploys.
   - `ANTHROPIC_API_KEY` = your Claude API key (console.anthropic.com) — turns on the KIT Brain: any question the rule engine doesn't match gets answered by Claude with your live business data, JARVIS-style. Optional: `CLAUDE_MODEL` (default `claude-sonnet-4-6`).
   - `ELEVENLABS_API_KEY` = your ElevenLabs key — gives KIT its voice in the dashboard. Optional: `ELEVENLABS_VOICE_ID` (pick a voice in your ElevenLabs Voice Lab and paste its ID; a default voice is used otherwise) and `ELEVENLABS_MODEL` (default `eleven_turbo_v2_5`).

Without these two keys everything still runs — the brain falls back to the rule engine and the browser's built-in speech is used for voice.
4. Deploy. Health check: `https://YOUR-SERVICE.onrender.com/health`

## 3. Connect Claude

1. Claude.ai → Settings → Connectors → **Add custom connector**
2. URL: `https://YOUR-SERVICE.onrender.com/mcp/YOUR_MCP_PATH_TOKEN`
   (token in the URL path — same pattern as your KTB Agent Stack connector; no OAuth needed)
3. Claude gets 31 tools: operator summary, ask_operator (conversational), tasks, approvals, KPIs, benchmarks, business reviews, hard truths, webinar cadence, scale readiness, growth audits, page audits + draft revisions, cinematic projects/briefs/storyboards, GHL workflow inventory + QA audits, nurture sequence drafts, campaigns, decisions, activity log.

## 4. First 10 minutes of use

1. Open the dashboard, go to **KPIs & Benchmarks**, log last week's real numbers (leads, calls, show-up, close, content pieces).
2. Ask the console: **"weekly operator summary"** — the hard-truth panel, cadence recommendation, and scale verdict activate immediately.
3. In Claude: "Give me my weekly operator summary" → Claude pulls it live through the connector.

## Governance guarantees

- Claude can REQUEST approvals but can never approve them — only the dashboard approve button (you) can.
- The governance agent drafts page revisions; nothing publishes anywhere.
- Every action by you, Claude, or the system lands in the Activity Log.

## The JARVIS loop (voice)

In the dashboard: tap the 🎙 button → speak → KIT transcribes (browser speech recognition — Chrome/Edge/Safari), thinks (Claude Brain if `ANTHROPIC_API_KEY` is set), and answers out loud (ElevenLabs if `ELEVENLABS_API_KEY` is set; browser voice otherwise). The arc ring shows state: idle / listening / thinking / speaking. The Voice checkbox turns spoken replies on for typed commands too.

## Cinematic Studio connectors

Higgsfield and Kling AI are pre-registered as Studio providers. Both work as **Claude.ai MCP connectors**, not stored API keys:
- **Higgsfield** — already in your connectors (`https://mcp.higgsfield.ai/mcp`). Claude generates images/video/3D directly; KIT holds the creative brief, storyboard, and render-job status.
- **Kling AI** — add its MCP connector in Claude.ai → Settings → Connectors. Then the workflow is: KIT drafts the brief + scene prompts → Claude sends each scene to Kling → you log finished assets back on the project.

## Talk to KIT through Claude

With the connector added, Claude *is* another interface to KIT — say "ask my command center for the weekly operator summary" from your phone and Claude calls `ask_operator` live.
