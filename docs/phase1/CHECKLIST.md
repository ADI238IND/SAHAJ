# Phase 1 Foundation Closure Acceptance Checklist

## 1. Overview & Scope

Phase 1 establishes the secure build, API foundation, database schema, Row-Level Security (RLS), private media storage, and bounded health/readiness architecture for Project SAHAJ.

- **Worktree**: `D:/Projects/SAHAJ/.worktrees/antigravity-foundation`
- **Branch**: `feature/phase1-closure`
- **Ownership Scope**:
  - `apps/api/src/app/api/health/**`
  - `apps/api/src/lib/health/**`
  - `apps/api/tests/health/**`
  - `infra/supabase/tests/phase1_*.sql`
  - `docs/phase1/**`
- **Untouched paths**: All adapters, media, cron, Atlas, Cedar, migrations, package manifests, and lockfiles.

---

## 2. Build & Install Integrity

- [x] **Frozen Lockfile**: Verified via `pnpm install --frozen-lockfile`.
- [x] **Exact esbuild Approval**: `package.json` pnpm configuration maintains exact build approval (`onlyBuiltDependencies: ["esbuild"]`); no global build script execution bypass (`ignore-scripts` or wildcard approvals) introduced.
- [x] **TypeScript Typecheck**: Verified zero type errors via `pnpm --filter @sahaj/api typecheck` (`tsc --noEmit`).
- [x] **Production Build**: Verified clean Next.js Turbopack build via `pnpm --filter @sahaj/api build`.

---

## 3. API Health & Dependency Readiness

- [x] **Bounded Readiness Architecture**:
  - Replaced static `"database": "not-yet-connected"` placeholder with real dependency probe.
  - Implemented dependency injection via `ReadinessDependencies` port (`apps/api/src/lib/health/`).
  - Probes database connectivity and schema existence with an explicit `3000ms` bounded deadline (`AbortController` + `abortSignal`).
- [x] **Liveness vs. Readiness Distinction**:
  - Liveness probe (`/api/health/liveness` or `GET /api/health?probe=liveness`) returns HTTP 200 confirming process vitality.
  - Readiness probe (`/api/health/readiness` or default `GET /api/health`) evaluates dependencies and returns HTTP 200 when ready or HTTP 503 Service Unavailable when configuration, connectivity, or schema is missing or timed out.
- [x] **Safe Error Bodies**:
  - Zero leakages: credentials, connection strings, tenant UUIDs, and raw SQL/PostgreSQL error traces are never exposed in JSON responses.
  - Standardized bounded error codes: `database_not_configured`, `database_unreachable`, `database_timeout`, `schema_missing`, `database_error`.
- [x] **Disabled Care Actions & Emergency Readiness**:
  - `emergency_ready: false` strictly enforced across all health responses.
  - `care_actions: "disabled"` and `voice: "disabled"` explicitly reported.
- [x] **HTTP Caching**:
  - Strict `Cache-Control: no-store` response header attached to all health routes.

---

## 4. Database Security & Isolation (Rollback Acceptance Assertions)

- [x] **Acceptance Suite**: Implemented in `infra/supabase/tests/phase1_security_acceptance.sql`.
- [x] **Rollback-Only**: Encapsulated within `begin; ... rollback;`; zero persistent state or test residue.
- [x] **Application Table RLS**:
  - Validates `relrowsecurity = true` across all 28 foundation and Core 1 tables in `public`, `sahaj_private`, and `sahaj_checkpoints`.
- [x] **Anonymous Role Boundary**:
  - Confirms default deny: `anon` cannot read or write any application tables (`families`, `people`, `calls`, `incidents`, `raw_events`, `consents`, etc.).
- [x] **Authenticated Tenant Boundary**:
  - Cross-tenant fencing: Family A members cannot view or access Family B data.
  - Role fencing: Child, Parent, and Circle roles strictly adhere to least-privilege visibility rules.
  - Revoked membership: `revoked_at` revocation immediately cuts off all tenant access.
  - Client mutation denial: `authenticated` role cannot update `family_memberships` or `consents`.
- [x] **Private Schema & Bucket Isolation**:
  - `sahaj_private` and `sahaj_checkpoints` schemas grant zero `USAGE` to `anon` or `authenticated`.
  - Media storage buckets (`sahaj-voice`, `sahaj-recordings`, `sahaj-lines`) verified private (`public = false`).
- [x] **Service-Only RPCs**:
  - Verifies that all 13 service-only database procedures cannot be executed by `anon` or `authenticated`, and are granted solely to `service_role`.
- [x] **Checkpoint Runtime Role Least Privilege**:
  - `sahaj_atlas_runtime` role has NO database `CREATE` privilege.
  - Restricted to `USAGE` on `sahaj_checkpoints` with zero access to `sahaj_private` or sensitive application tables.

---

## 5. Foundation Defect Report & Proposed Patch to Codex

### Defect Notice: `scripts/check.ps1` Local Smoke Expectation
- **Observed Behavior**: The existing scaffold script `scripts/check.ps1` calls `GET http://localhost:3000/api/health` and throws if the HTTP status is not 200 (`if (-not $health.ok)`).
- **Impact**: Under Phase 1 foundation readiness, `/api/health` correctly returns HTTP 503 in local development environments where real Supabase credentials (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) are intentionally not configured.
- **Proposed Patch to Codex** (since `scripts/` is outside Antigravity's owned paths):
  ```diff
  --- a/scripts/check.ps1
  +++ b/scripts/check.ps1
  @@ -2,3 +2,3 @@
   Write-Host 'Checking Sahaj local API http://localhost:3000 ...'
  -$health = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -Method Get
  +$health = Invoke-RestMethod -Uri 'http://localhost:3000/api/health?probe=liveness' -Method Get
   if (-not $health.ok -or $health.emergency_ready) { throw 'Unexpected health response' }
  ```
  Alternatively, operators testing full readiness can set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to verify the 200 readiness path.

---

## 6. Remaining Remote Verification (Required Before 100% Phase 1 Closure)

In accordance with Phase 1 instructions, Phase 1 cannot be declared 100% complete until the following remote checks are completed by Codex:

1. **Remote Database Security Acceptance**:
   - Execute `infra/supabase/tests/phase1_security_acceptance.sql` against the connected hosted Supabase project.
   - Verify transaction rolls back with zero assertion exceptions.
2. **Deployed Vercel Health & Readiness**:
   - Trigger deployment of the integration branch containing Phase 1 closure.
   - Probe deployed endpoint `/api/health?probe=liveness` -> returns HTTP 200 with `no-store`.
   - Probe deployed endpoint `/api/health` (readiness) with configured database -> returns HTTP 200 (`database.status = "connected"`).
3. **Combined Multi-Worker Integration**:
   - Merge `feature/phase1-closure` into the main integration branch (`feature/core1-atlas`).
   - Run complete suite (combined build, typecheck across all packages, 311+ tests).
