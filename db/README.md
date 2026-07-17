# PostgreSQL persistence foundation

The legacy store managed these collections: `agents`, `goals`, `tasks`, `approvals`, `campaigns`, `audits`, `findings`, `recommendations`, `workflows`, `assets`, `kpis`, `benchmarks`, `reviews`, `scorecards`, `decisions`, `events`, `cinematic_projects`, `scenes`, and `edit_jobs`.

Migration 001 gives each collection a PostgreSQL table with a text primary key, JSONB business payload, and database-managed `created_at`/`updated_at` timestamps. It also adds the previously implicit `providers` entity as its own table. Nurture workflows, page revisions, and sequence drafts remain variants in `workflows`; render jobs and GHL snapshots remain variants in `assets`. This preserves the executable model without inventing new business behavior.

Indexes cover current query paths: task status/goal, approval status, KPI metric/period, audit module/status, finding status/severity, scene project, asset project/type, workflow kind/status, event chronology, and editor-job status. Events are append-only in both the store and PostgreSQL trigger layer.

The application keeps the existing synchronous `create`, `get`, `list`, `update`, and `remove` interface over a startup-loaded working set. PostgreSQL is the only production writer. REST and MCP boundaries flush queued operations before acknowledging requests. `store.transaction()` batches related operations into a PostgreSQL transaction and restores the working set on rollback. Updates use optimistic timestamp checks to reject stale concurrent writes.

JSON remains available only as an explicit non-production fallback and as immutable migration/rollback input. `scripts/import-json.js` preserves IDs and timestamps, skips existing IDs, and separates legacy provider records from general assets.
