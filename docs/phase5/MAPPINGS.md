# Core 2 Server ↔ Mobile / Shield Contract Mappings

This document details the observed contract differences, architectural mappings, and schema alignments between the Mobile Client App (`apps/child/lib/api.ts`), Shield Runtime (`packages/shield`), and the Core 2 Server endpoints (`apps/api/src/app/api/core2/**`).

---

## 1. Architectural Scope & Base Paths

| Scope | Base URL Path | Primary Responsibility | Ownership |
|---|---|---|---|
| **Shield Mobile API** | `/api/app/*` | Scam alerts, busy replies, pairing, phone telemetry, timeline query | Lead lane (`apps/child`, `packages/shield`) |
| **Core 2 Safety API** | `/api/core2/*` | Adult-Child SOS, Late-Home Watch, "Main safe hoon", Trusted Contacts, Verified Responder Acceptance, Maa's Truth-Line | Phase 5 (`apps/api/src/lib/core2`) |
| **Unified Timeline** | `/api/app/timeline` / Internal Port | Signed Ed25519 hash-chained append-only event ledger | Shared (`apps/api/src/lib/timeline.ts`) |

---

## 2. Authentication & Tenancy Alignment

| Concern | Mobile Client (`apps/child/lib/api.ts`) | Core 2 Server (`apps/api/src/app/api/core2/*`) | Integration Resolution / Mapping |
|---|---|---|---|
| **Bearer Token** | `session.token` (custom session / device token) | Supabase auth bearer token verified via `getUser()` | The mobile app session token must map to a verified Supabase user ID with active `family_memberships`. |
| **Family Scoping** | Implicit in device pairing session | Explicit `familyId` (UUID) verified against user's membership | Mobile requests to Core 2 routes must supply `familyId` in request bodies / query parameters. |
| **Role Enforcement** | Implicit client role | Strict RBAC (`parent`, `child`, `circle`) enforced server-side | E.g., only `child` may revoke contacts or set late watch; `parent` or `child` may query truth-line. |

---

## 3. Idempotency & Conflict Handling

| Concern | Mobile Client (`apps/child/lib/api.ts`) | Core 2 Server (`apps/api/src/app/api/core2/*`) | Integration Resolution / Mapping |
|---|---|---|---|
| **Key Location** | HTTP Header: `Idempotency-Key: app-<ts>-<rnd>` | JSON Body property: `idempotencyKey` (bounded string, max 256 chars) | Core 2 accepts in-body `idempotencyKey` and calculates SHA-256 hash of payload. |
| **Conflict Detection**| Not tracked in mobile client | Replaying same key with changed body triggers `409 Conflict` (`idempotency_payload_conflict`) | Mobile retry logic must preserve identical request bodies upon retry. |
| **Replay Semantics** | Returns raw response | Returns cached response with `{ replayed: true }` flag and zero duplicate outbox dispatches | Prevents duplicate SMS/WhatsApp notifications to family responders. |

---

## 4. Endpoint & Payload Mappings

### 4.1 SOS Emergency Trigger

* **Core 2 Endpoint:** `POST /api/core2/sos`
* **Mobile Client Mapping:**
  ```json
  {
    "familyId": "UUID",
    "personId": "UUID",
    "idempotencyKey": "string (1-256)",
    "triggerType": "sos_button | late_watch_timeout | panic_phrase",
    "locationHint": "optional string (max 256)",
    "note": "optional string (max 512)"
  }
  ```
* **Server Action:**
  1. Encrypts raw event payload with AES-256-GCM before returning HTTP 202.
  2. Queries active, non-revoked trusted contacts for the child.
  3. Evaluates Cedar authorization gate (`urgent_responder`).
  4. Dispatches atomic outbox messages for verified responders.
  5. Signs emergency incident into the Ed25519 hash-chained timeline.

### 4.2 "I Am Safe" ("Main safe hoon") Reassurance

* **Core 2 Endpoint:** `POST /api/core2/safe`
* **Mobile Client Mapping:**
  ```json
  {
    "familyId": "UUID",
    "personId": "UUID",
    "idempotencyKey": "string (1-256)",
    "reassuranceNote": "optional string (max 512)"
  }
  ```
* **Server Action:**
  1. Monotonically transitions active or overdue watches to `safe`.
  2. Resolves open incidents to `done`.
  3. Prohibits state reversion back to `escalated` (monotonic forward rule).
  4. Enqueues outbox broadcast to family informing them that the child is safe.
  5. Signs `core2.child.safe_confirmed` into the timeline.

### 4.3 Late-Home Watch

* **Core 2 Endpoints:**
  * `POST /api/core2/watch` (Create watch)
  * `GET  /api/core2/watch?familyId=...&personId=...` (Get active watch)
* **Mobile Client Mapping:**
  ```json
  {
    "familyId": "UUID",
    "personId": "UUID",
    "idempotencyKey": "string (1-256)",
    "destinationLabel": "string (1-256)",
    "originLabel": "optional string (max 256)",
    "transportNote": "optional string (max 512)",
    "minutesUntilExpected": "integer (1-720)"
  }
  ```
* **Server Action:**
  1. Rejects if an active watch already exists for this person (`409 Conflict`).
  2. Sets `expectedBy = now + minutesUntilExpected`.
  3. Grace period defaults to 300 seconds (5 minutes); `escalateAfter = expectedBy + gracePeriod`.
  4. Signs `core2.watch.scheduled` into the timeline.

### 4.4 Trusted Contacts Management

* **Core 2 Endpoints:**
  * `POST /api/core2/contacts` (Add contact)
  * `GET  /api/core2/contacts?familyId=...&childPersonId=...` (List contacts)
  * `POST /api/core2/contacts/[id]/revoke` (Revoke contact)
* **Mobile Client Mapping:**
  ```json
  // Add Contact
  {
    "familyId": "UUID",
    "childPersonId": "UUID",
    "contactPersonId": "UUID",
    "priorityOrder": "integer (1-20)",
    "relationship": "string (1-64)",
    "capabilities": ["emergency_alert", "voice_reassurance"],
    "idempotencyKey": "string (1-256)"
  }

  // Revoke Contact
  {
    "familyId": "UUID",
    "contactId": "UUID",
    "reason": "optional string (max 256)"
  }
  ```
* **Server Action:**
  1. Revocation marks `revoked_at = now()`.
  2. Future SOS alerts and overdue escalations filter out revoked contacts immediately.
  3. Signs `core2.trusted_contact.revoked` into the timeline.

### 4.5 Verified Responder Acceptance

* **Core 2 Endpoint:** `POST /api/core2/incident/[id]/accept`
* **Mobile / Ingress Mapping:**
  ```json
  {
    "familyId": "UUID",
    "incidentId": "UUID",
    "responderPersonId": "UUID",
    "providerEventId": "string",
    "accountId": "string",
    "acceptanceToken": "optional string",
    "rawEventId": "optional UUID"
  }
  ```
* **Server Action:**
  1. Verifies that the responder was offered an assignment for this incident.
  2. Enforces family tenant isolation (rejects same-family target substitution by unoffered members).
  3. Cryptographically validates provider event provenance against ingested raw events.
  4. Transitions incident to `accepted` and assignment to `accepted`.
  5. Signs `core2.incident.responder_accepted` into the timeline.

### 4.6 Maa's Truth-Line

* **Core 2 Endpoint:** `GET /api/core2/truth-line?familyId=...&queriedByPersonId=...&targetPersonId=...&queryType=...`
* **Query Types:** `safety_status | whereabouts_reassurance | incident_status`
* **Response Structure:**
  ```json
  {
    "status": "safe | monitoring | urgent_action_underway",
    "phrase_hi": "सुरक्षित हैं...",
    "phrase_en": "Safe and accounted for...",
    "redacted": true,
    "consent_verified": true,
    "last_updated": "ISO8601"
  }
  ```
* **Privacy & Redaction:**
  1. Redacts 10-digit mobile numbers to `<MOBILE_10>`.
  2. Redacts vehicle registration plates (e.g. DL 01 AB 1234) to `<VEHICLE_NUM>`.
  3. Redacts arbitrary numbers with 4+ digits to `<NUM>`.
  4. Returns bilingual Hindi & English reassuring explanations for aging parents.

---

## 5. Security & Isolation Boundaries

1. **Zero Provider Side-Effects Without Cedar Authorization:** No alert, call, or message is queued into the outbox until Cedar gate evaluates to `allow`.
2. **Encrypted Persistence Before 202:** Raw trigger events are AES-256-GCM encrypted and committed to the event store before HTTP 202 is returned to the client.
3. **Monotonic Forward Watch Transitions:** Once a late watch is marked `safe`, it cannot be transitioned to `escalated` by delayed cron ticks.
4. **Tenant Isolation:** All queries, RPCs, and state updates enforce `family_id` scoping at both the database RLS layer and application service layer.
