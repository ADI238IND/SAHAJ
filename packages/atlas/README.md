# Atlas workflow scaffold

Actual LangGraph `StateGraph` with checkpointed review and delivery interrupts. This is a backend scaffold; Hindi conversation, AI understanding, provider adapters and a database-backed repository/outbox worker remain integration work.

`createAtlas(ports, checkpointer)` exposes `start({familyId, jobId})` and `resume({familyId, jobId})`. Callers must authenticate and authorize family access. The loader verifies persisted job ownership before checkpoint lookup. IDs are UUIDs. Thread IDs deterministically hash family and job and stay under 255 characters.

The graph loads protected records, projects understanding into action/certainty enums, guards with Cedar, enqueues an authorized command, waits for verified delivery, and appends a signed outcome. Uncertain or unauthorized decisions interrupt for review. Resume is a wakeup only; approvals come from reloaded server records. Urgent responder delivery remains pending until verified acceptance. Payments, OTP collection and diagnosis cannot dispatch.

Checkpoints contain identifiers and enums. No gate snapshots, provider payloads, transcripts or raw model output are stored. Disable remote tracing unless an approved redaction pipeline exists. Keep protected payloads in their controlled repository.

Repository integration is mandatory: `withJobLock` must serialize jobs across processes. `enqueueAuthorized` must recover an existing stable outbox key first; otherwise atomically reauthorize current permissions/consents/approvals, consume approval and usage capacity, and insert a unique outbox row. The graph does not call providers. A durable outbox worker handles dispatch/retry and provider idempotency where supported. `appendSignedOutcome` must use the real signed timeline writer and enforce unique keys.

Use `createPostgresCheckpointer(DATABASE_URL)` from `@sahaj/atlas/postgres` in Node.js. It selects private `sahaj_checkpoints` and never runs migrations. Before starting workers, explicitly run `pnpm --filter @sahaj/atlas setup-checkpointer` using a database-owner connection. Setup revokes public/anon/authenticated schema and table access, enables RLS, and serializes migrations. Configure a narrowly managed runtime database role and keep this schema outside PostgREST exposure. Close the saver with `await saver.end()` on worker shutdown.

Tests use `MemorySaver` and reconstruct the graph using the same saver. They prove interrupt/resume/retry behavior and stable idempotency keys, not survival of an OS/process restart or a real database outage. Actual PostgresSaver restart integration remains pending database connectivity.

Run `pnpm --filter @sahaj/atlas typecheck` and `pnpm --filter @sahaj/atlas test`.
