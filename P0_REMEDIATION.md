# P0 Security Remediation Notes

This branch hardens the existing KIT prototype without adding business or JARVIS features.

## File-by-file summary

- `.gitignore` — excludes dependencies, secrets, logs, generated media, coverage, editor files, and explicitly local JSON data.
- `.env.example` — documents secure startup and remote-download controls without containing secrets.
- `package.json` / `package-lock.json` — adds Helmet, API rate limiting, test/check scripts, and a complete reproducible ffmpeg dependency graph.
- `server.js` — adds the startup security gate, Helmet, rate limits, signed media mounting, minimal liveness, sanitized error handling, and testable app construction.
- `src/api.js` — requires authentication, validates mutation bodies, derives actor identity server-side, protects diagnostics, sanitizes errors, and logs approval attempts.
- `src/security.js` — centralizes startup policy, constant-time key comparison, owner authentication, public-safe errors, and structured security logs.
- `src/validation.js` — enforces JSON-object mutation bodies, nesting/array limits, forbidden prototype keys, and required fields for primary write routes.
- `src/media.js` — creates and verifies short-lived HMAC media links and constrains resolved paths to the media root.
- `src/remoteDownload.js` — blocks private/reserved destinations, validates every redirect, applies optional host allowlisting, enforces time/size/content-type limits, streams to disk, and removes partial files.
- `src/zoom.js` — routes MP4 and transcript downloads through the hardened streaming downloader.
- `src/modules/editor.js` — emits fresh signed media links instead of public static URLs.
- `src/modules/commandCenter.js` — requires the server-derived owner, rejects repeat decisions, and preserves final decision events.
- `src/mcp.js` — authenticates MCP DELETE requests consistently with POST/GET.
- `public/app.js` — replaces inline click handlers with delegated event bindings so the working UI remains compatible with the strict content security policy.
- `test/security.test.js` — regression coverage for startup, auth, headers, rate limiting, validation, sanitized errors, approval governance, signed media, MCP auth, SSRF/redirect controls, timeouts, size/type limits, cleanup, and log redaction.
- `DEPLOY.md` — switches deployment to `npm ci` and documents mandatory production auth and ingestion controls.

## Verification commands

```bash
npm ci
npm run check
npm test
NODE_ENV=production DATA_DIR=/tmp/kit-test node server.js
NODE_ENV=production ADMIN_KEY=... MCP_PATH_TOKEN=... DATA_DIR=/tmp/kit-test npm start
curl http://127.0.0.1:3000/health
curl -H 'x-admin-key: ...' http://127.0.0.1:3000/api/diagnostics
```

The first production command is expected to fail because `ADMIN_KEY` is absent.

## Remaining risks

- JSON-file persistence is still single-process, non-transactional, and unsuitable for horizontal scaling.
- The shared admin key is not a user/session identity system; rotate it if exposed and restrict dashboard access at the hosting layer.
- DNS validation materially reduces SSRF risk but does not pin the validated IP through the subsequent HTTP connection. Production egress filtering remains recommended.
- MCP still authenticates with a URL path token, which may appear in proxy access logs.
- Signed media URLs remain usable by anyone who receives them until their five-minute expiry.
- Third-party API integrations still need credentialed staging tests.
- Rate limits use in-memory state and are per process.

## Rollback plan

1. Stop the deployment or route traffic to the last known-good Render release.
2. Revert this branch's single remediation commit on a new rollback branch.
3. Redeploy using the previous release artifact and previous environment variables.
4. Preserve `DATA_DIR` and media disk contents; the remediation does not migrate stored JSON.
5. If only authentication configuration caused startup failure, set a valid `ADMIN_KEY` rather than reverting code.

Do not roll back the security controls while retaining public exposure. If emergency rollback is required, restrict the service at the hosting/network layer first.
