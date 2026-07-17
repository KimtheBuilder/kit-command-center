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
   - **Build Command:** `npm ci`
   - **Start Command:** `npm start`
   - **Instance:** free tier works for V1
3. Required production security and persistence variables:
   - `MCP_PATH_TOKEN` = a long random string you invent.
   - `ADMIN_KEY` = a different random secret of at least 32 characters. **Required in production; the service refuses to start without it.** The UI prompts once and stores it in the browser.
   - `VIDEO_ALLOWED_HOSTS` = comma-separated exact hostnames/domains permitted as video sources, including the Zoom download hosts used by your account. **Required and fail-closed in production.** Redirects are checked against the same list.
   - `DATA_DIR` = `/var/data`. Add a Render persistent disk mounted at `/var/data`; otherwise operational data is lost on redeploy.
   - `TRUST_PROXY_HOPS` = `1` on Render. Do not increase it unless another trusted proxy is deliberately added.
   - Optional tuning: `API_RATE_LIMIT` (default `300` per 15 minutes) and `MCP_RATE_LIMIT` (default `120` per minute).

4. Optional integration variables:
   - `ANTHROPIC_API_KEY` = your Claude API key (console.anthropic.com) — turns on the KIT Brain. Optional: `CLAUDE_MODEL` (default `claude-sonnet-4-6`).
   - `ELEVENLABS_API_KEY` = your ElevenLabs key — gives KIT its voice. Optional: `ELEVENLABS_VOICE_ID` (pick a voice in ElevenLabs and paste its ID) and `ELEVENLABS_MODEL` (default `eleven_turbo_v2_5`).
   - `KTB_STACK_MCP_URL` = your Agent Stack MCP URL — plugs your six KTB Agent Stack agents INSIDE KIT.

Without the optional integration keys, the core command center still runs: the brain falls back to the rule engine, browser speech covers voice, and disconnected integrations remain disabled. The required production variables above cannot be omitted.

For local-only development without an admin key, explicitly set `ALLOW_INSECURE_DEV_AUTH=true` while `NODE_ENV` is not `production`. Never use that flag on Render. Approval decisions remain owner-authenticated and are unavailable through the insecure development bypass.

Additional video-ingestion controls:
- In development only, `VIDEO_ALLOWED_HOSTS` may be blank to permit arbitrary public hosts. Production refuses to start with an empty allowlist.
- `VIDEO_MAX_BYTES` — maximum download size; defaults to 2 GiB.
- `VIDEO_CONNECT_TIMEOUT_MS` — DNS/connection timeout; defaults to 15 seconds.
- `VIDEO_DOWNLOAD_TIMEOUT_MS` — total body download timeout; defaults to 15 minutes.
5. Deploy. Health check: `https://YOUR-SERVICE.onrender.com/health`
   Readiness check (includes persistence): `https://YOUR-SERVICE.onrender.com/ready`
   Authenticated operational diagnostics: `GET /api/diagnostics` with header `x-admin-key: YOUR_ADMIN_KEY`.

### PostgreSQL on Render

1. Create a Render PostgreSQL database in the same region as the web service.
2. Set `DATABASE_URL` to Render's internal database URL. PostgreSQL is mandatory when `NODE_ENV=production`; startup fails closed if it is absent or unreachable.
3. Set `DB_SSL=false` for Render's internal URL (`true`/`require` for an external provider that requires TLS), `DB_POOL_MAX=10`, and `DB_CONNECTION_TIMEOUT_MS=10000`.
4. Deploy normally. Startup applies pending migrations transactionally and records versions in `schema_migrations`. The readiness endpoint returns `503` until the database is available.
5. Before the first production cutover, preserve the existing JSON directory as a backup and run `JSON_IMPORT_DIR=/path/to/json npm run db:import-json` once. Imports preserve IDs/timestamps, skip existing IDs, split legacy provider records into `providers`, and never edit or delete the JSON source.
6. Verify record counts and application behavior, then retain the JSON backup for rollback. PostgreSQL-enabled production never writes new application data to JSON.

Operational commands:

- Apply migrations: `npm run db:migrate`
- Roll back migrations above a target: `DB_MIGRATION_TARGET=0 npm run db:rollback`
- Import the JSON backup: `JSON_IMPORT_DIR=/path/to/data npm run db:import-json`

Rollback: stop application writes, take a PostgreSQL backup, run the migration rollback only when intentionally abandoning the PostgreSQL schema, remove `DATABASE_URL`, and deploy with a non-production `NODE_ENV` pointed at the preserved JSON backup. Production intentionally cannot fall back silently to JSON.

## 3. Connect Claude

1. Claude.ai → Settings → Connectors → **Add custom connector**
2. URL: `https://YOUR-SERVICE.onrender.com/mcp/YOUR_MCP_PATH_TOKEN`
3. Claude gets 37 tools: operator summary, ask_operator, tasks, approvals, KPIs, benchmarks, business reviews, hard truths, webinar cadence, scale readiness, growth audits, page audits + draft revisions, cinematic projects, GHL workflow inventory + QA, nurture drafts, campaigns, decisions, the video editor (list zoom recordings, create edit jobs, job status), GHL sync + pipeline, activity log.

## 4. First 10 minutes of use

1. Dashboard → **KPIs & Benchmarks** → log last week's real numbers.
2. Console: **"weekly operator summary"** — hard truths, cadence, scale verdict activate.
3. In Claude: "Give me my weekly operator summary" → pulled live through the connector.

## Governance guarantees

- Claude can REQUEST approvals but can never approve them — only you can, in the dashboard.
- The governance agent drafts page revisions; nothing publishes anywhere.
- Every action lands in the Activity Log.

## The Editor (your own video editor)

KIT cuts your Zoom recordings into finished clips: horizontal masters for YouTube (lossless,
fast) and vertical 1080×1920 shorts with burned-in captions for reels/TikTok. Clip selection
runs on Kim's protocol via the KIT Brain.

**One-time setup (about 10 minutes):**

1. **Render muscle** — your service → Settings → Instance Type → **Starter** ($7/mo).
   Then Disks → **Add Disk**: name `kit-data`, mount path `/var/data`, size **10 GB** (~$2.50/mo).
   Add env var `DATA_DIR` = `/var/data`.
2. **Zoom Server-to-Server app** — marketplace.zoom.us → Develop → **Build App** →
   **Server-to-Server OAuth** → name it `KIT Editor` → Scopes: add the cloud recording READ scopes
   (`cloud_recording:read:list_user_recordings:admin` and `cloud_recording:read:recording:admin`;
   on older scope UIs just `recording:read:admin`) → **Activate**.
   Copy the three credentials into Render env vars: `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`.
3. In Zoom: keep **audio transcript** ON for cloud recordings (Settings → Recording →
   Advanced cloud recording settings → Audio transcript) — used for clip selection and captions.

**Using it:** dashboard → **Editor** → Load my Zoom recordings → **Cut clips**.
Or from Claude: "list my zoom recordings" → "cut clips from the Coffee & Credit one."

## GoHighLevel feed (dashboards fill themselves)

Two env vars in Render and KIT pulls your leads + pipeline every 12 hours automatically:
- `GHL_API_KEY` — your GHL Private Integration token (Settings → Private Integrations)
- `GHL_LOCATION_ID` — Settings → Business Profile → copy the Location ID

New contacts (7-day count) auto-record as the `leads_weekly` KPI; open opportunities and
pipeline value appear in snapshots, the KIT Brain, and the `ghl_pipeline` MCP tool.
Manual pull any time: "sync my GHL" via Claude (ghl_sync) or POST /api/ghl/sync.

## The JARVIS loop (voice)

Dashboard: tap 🎙 → speak → KIT transcribes, thinks (Claude Brain), answers aloud
(ElevenLabs voice if configured; browser voice otherwise). The arc ring shows state.

## Cinematic Studio connectors

Higgsfield and Kling AI work as **Claude.ai MCP connectors**: KIT drafts the brief + scene
prompts → Claude sends scenes to the generator → finished assets get logged on the project.

## Talk to KIT through Claude

With the connector added, Claude *is* another interface to KIT — say "ask my command center
for the weekly operator summary" from your phone and Claude calls `ask_operator` live.
