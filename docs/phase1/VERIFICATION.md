# Phase 1 Verification Guide

This document describes how to execute local verification and how Codex can run remote acceptance verification without exposing secrets.

---

## 1. Local Verification (Completed by Antigravity)

Run these checks inside the repository / worktree:

```powershell
# 1. Typecheck API package
pnpm --filter @sahaj/api typecheck

# 2. Run unit & route test suites (including health & readiness suite)
pnpm --filter @sahaj/api test

# 3. Compile optimized production build
pnpm --filter @sahaj/api build
```

### Local Test Coverage Summary:
- `tests/health/readiness.test.ts`: 9 tests verifying:
  - Database unconfigured / unavailable (503 `database_not_configured`)
  - Configured but unreachable (503 `database_unreachable`)
  - Missing schema detection (503 `schema_missing`)
  - Bounded timeout abort (503 `database_timeout`)
  - Transient failure recovery (transition from 503 to 200)
  - Safe error bodies (zero credentials, tenant identifiers, or SQL leaks)
  - Disabled care actions (`emergency_ready: false`, `care_actions: "disabled"`, `voice: "disabled"`)
  - Liveness vs readiness distinction (liveness 200 vs readiness 503)
  - Unhandled exception containment
- `tests/health/ports.test.ts`: 5 tests verifying mock Supabase client interactions, AbortSignal handling, error codes (42P01), and environment variable checks without network calls.
- `tests/health/routes.test.ts`: 5 tests verifying Next.js GET route handlers, query parameter handling, and `Cache-Control: no-store` headers.

Total API test suite: 195 tests passing across 15 test files.

---

## 2. Remote Database Acceptance Execution (Codex Action)

Execute the rollback-only SQL acceptance test against the connected Supabase instance:

```bash
# Using Supabase CLI (or psql with administrative connection string):
supabase db execute --file infra/supabase/tests/phase1_security_acceptance.sql
```

Or via `psql`:

```bash
psql "$SUPABASE_DB_URL" -f infra/supabase/tests/phase1_security_acceptance.sql
```

**Expected Outcome**:
- Script executes all 6 sections (RLS checks, schema/bucket privacy, runtime role least privilege, service RPC execution checks, synthetic tenant boundary fixtures).
- Reaches the final `rollback;` statement.
- Zero exceptions raised; output confirms `ROLLBACK`. Zero persistent rows left in the database.

---

## 3. Safe Deployed Health Verification (Codex Action)

To verify the deployed API without reading or logging sensitive tokens or environment variables, execute `docs/phase1/verify_live.sh` or `docs/phase1/verify_live.ps1`.

### Using Bash:

```bash
./docs/phase1/verify_live.sh https://<deployed-domain> [optional-vercel-protection-bypass-token]
```

### Using PowerShell:

```powershell
./docs/phase1/verify_live.ps1 -BaseUrl "https://<deployed-domain>" [-BypassSecret "optional-secret"]
```

### Checks performed:
1. `GET /api/health/liveness`:
   - Validates HTTP status is 200.
   - Validates `Cache-Control` header contains `no-store`.
   - Validates JSON body has `ok: true`, `probe: "liveness"`, `emergency_ready: false`.
2. `GET /api/health?probe=liveness`:
   - Validates query parameter liveness probe returns HTTP 200.
3. `GET /api/health` (Readiness Probe):
   - Validates `Cache-Control` header contains `no-store`.
   - If connected: validates HTTP status 200, `status: "ready"`, `database.status: "connected"`, `database.schema: "present"`.
   - Validates response does NOT leak any credentials, connection strings, or tenant identifiers.
   - Validates `emergency_ready` is strictly `false` and `care_actions` is `"disabled"`.
