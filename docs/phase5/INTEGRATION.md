# Core 2 Parent Integration Guide & Contract Seams

This guide outlines the required parent integration steps, external documentation access status, and upstream contract seams for merging and activating the Phase 5 (Core 2) safety server.

---

## 1. External Documentation Access Report

In accordance with instructions, attempts were made to inspect the authoritative specifications from the external Google Docs URLs:
* **Build Bible:** `https://docs.google.com/document/d/1BLnuLwtsqdb57FK8aJDedC7EQmv_5y3s7LFq_gxt1OQ`
* **Work Division:** `https://docs.google.com/document/d/1lQlNRLSDyCcyDxqW1_S8qhPdgDYbyFYq-QojqqD0Zm4`
* **Ready Kit:** `https://docs.google.com/document/d/1EFDIoc6Wl3Cf-LZ1OypADot2t-gxFwMpNG-RnsF4t5Q`

**Status:** **INACCESSIBLE (Network / Auth Boundary).**
The sandboxed execution environment prohibits external internet fetches without pre-configured credentials.

**Resolution:**
The system relied strictly upon internal repo-authoritative contracts:
* Root coordination specifications: `coordination/ANTIGRAVITY-PHASE5.md` and `coordination/ANTIGRAVITY-PHASE4.md`
* Existing repository schemas and contracts: `packages/gate`, `packages/adapters`, `apps/api/src/lib/timeline.ts`, `apps/api/src/lib/event-store.ts`, `apps/api/src/lib/webhook-security.ts`
* Mobile client inspection: `.worktrees/leader-integration/apps/child/lib/api.ts`
* Shield runtime inspection: `packages/shield/src/runtime`
* Lead agent directives: `AGENTS.md`

No provider facts, credentials, or arbitrary protocols were invented.

---

## 2. Required Parent Integration Changes

Per the boundary constraints of Phase 5, existing shared files (such as cron tick routes and package manifests) were kept untouched. The parent repository maintainer must perform the following integration tasks:

### 2.1 Wiring Global Cron Tick Route

* **Target File:** `apps/api/src/app/api/cron/tick/route.ts`
* **Required Change:** Add invocation of Core 2 overdue watch processing inside the global cron loop:
  ```typescript
  import { getDefaultCore2Service } from "@/lib/core2";

  // Inside the cron tick execution handler:
  const core2Service = getDefaultCore2Service();
  const overdueResult = await core2Service.handleProcessOverdueWatches({
    workerId: "global-cron-worker",
    leaseSeconds: 60,
    limit: 20,
  });
  console.log(`[Cron] Core 2 overdue watches processed: claimed=${overdueResult.body.claimed_count}, escalated=${overdueResult.body.escalated_count}`);
  ```
* **Alternatively:** Configure a scheduled HTTP invocation calling `POST /api/core2/cron/overdue` with header `x-cron-secret: <CRON_SECRET>`.

### 2.2 Database Migration Execution

* **Target Migration:** `infra/supabase/migrations/20261114230000_phase5_core2.sql`
* **Action:** Apply to the hosted Supabase instance.
* **Validation:** Run `infra/supabase/tests/phase5_core2.sql` using pgTAP or Supabase test runner to verify tenant isolation, monotonic triggers, and RLS policies.
* **Rollback Script:** `docs/phase5/ROLLBACK.sql` is provided if roll-back is required.

### 2.3 Upstream Core 1 Voice Consent Seam (Phase 4)

* **Integration Point:** `apps/api/src/lib/core2/reassurance.ts` & `apps/api/src/app/api/core2/truth-line/route.ts`
* **Required Change:** Connect Core 1's voice consent repository with Core 2's truth-line query handler. When Core 1 captures a parent's voice consent grant, write the corresponding record to `public.core2_truth_line_queries` or pass consent state to `generateReassurance`.

### 2.4 Upstream Kiro Provider Ingestion Seam (Phase 2 & 3)

* **Integration Point:** `apps/api/src/app/api/core2/incident/[id]/accept/route.ts`
* **Required Change:** Forward incoming WhatsApp responder reply webhooks (`"HAAN" / "I ACCEPT"`) from Kiro's provider gateway directly to Core 2's verified responder acceptance endpoint `POST /api/core2/incident/[id]/accept` with `providerEventId` matching the raw event stored in `raw_events`.

### 2.5 Mobile Client Route Wiring

* **Target Files:** `apps/child/lib/api.ts` & `apps/parent`
* **Required Change:** Add client methods to invoke Core 2 endpoints:
  * `sos(payload)` -> `POST /api/core2/sos`
  * `safe(payload)` -> `POST /api/core2/safe`
  * `startWatch(payload)` -> `POST /api/core2/watch`
  * `truthLine(params)` -> `GET /api/core2/truth-line`
* Refer to `docs/phase5/MAPPINGS.md` for complete payload structures and error handling rules.

---

## 3. Combined Backend State Summary

As specified in `coordination/ANTIGRAVITY-PHASE5.md`:
> *"Phase2/3 and Phase4 are unfinished so final end-to-end acceptance must remain visibly pending until parent integration."*

| Component | Status | Verification Detail |
|---|---|---|
| **Phase 5 (Core 2 Server)** | **READY_FOR_INTEGRATION** | 25/25 unit & route test files passed (267/267 tests); 15/15 acceptance scenarios passed. Typecheck clean. |
| **Phase 4 (Core 1 Voice / Pulse)** | **PENDING_PARENT_INTEGRATION** | Awaiting parent merge of Core 1 voice consent and call handling. |
| **Phase 2 & 3 (Kiro Ingestion)** | **PENDING_PARENT_INTEGRATION** | Awaiting parent merge of Kiro provider webhook forwarding. |
| **Overall Combined Backend** | **PENDING_PARENT_INTEGRATION** | Blocked on global cron wiring and live Supabase migration. |
