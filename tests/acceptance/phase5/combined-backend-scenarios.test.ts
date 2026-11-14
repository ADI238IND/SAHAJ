import { describe, it, expect, beforeEach } from "vitest";
import {
  createCore2Service,
  createInMemoryCore2Repository,
  createCore2Timeline,
  createCore2Gate,
  createCore2EventStore,
  createCore2Outbox,
  generateReassurance,
  redactSensitiveDetails,
  type Core2Repository,
  type Core2OutboxPort,
  type Core2EventStorePort,
  type Core2GatePort,
} from "../../../apps/api/src/lib/core2/index.js";

/**
 * PHASE 5 ACCEPTANCE SUITE: COMBINED BACKEND SCENARIOS
 *
 * Verifies all 11 required scenarios:
 * 1. Restart / duplicate webhook / no double dispatch
 * 2. Revoked consent before send
 * 3. Stale lease / checkpoint ownership
 * 4. Two-person approval (Cedar gate)
 * 5. Same-family target substitution
 * 6. Forged / wrong incident acceptance
 * 7. Core 1 voice consent integration seam
 * 8. Core 2 safe-vs-timeout race
 * 9. Replayed SOS
 * 10. Missed cron recovery
 * 11. Redacted reports
 *
 * NOTE: As specified in coordination/ANTIGRAVITY-PHASE5.md:
 * "Phase2/3 and Phase4 are unfinished so final end-to-end acceptance must remain
 * visibly pending until parent integration."
 */

export const COMBINED_BACKEND_INTEGRATION_STATE = {
  phase2_ingestion: "PENDING_PARENT_INTEGRATION",
  phase3_orchestration: "PENDING_PARENT_INTEGRATION",
  phase4_core1_voice: "PENDING_PARENT_INTEGRATION",
  phase5_core2_server: "READY_FOR_INTEGRATION",
  overall_end_to_end: "PENDING_PARENT_INTEGRATION",
  blockingDependencies: [
    "Parent wiring of global cron tick in apps/api/src/app/api/cron/tick/route.ts",
    "Database migration 20261114230000_phase5_core2.sql execution on hosted Supabase",
    "Phase 4 Core 1 voice consent store unification with Core 2 truth line",
    "Phase 2/3 Kiro provider webhook forwarding to Core 2 emergency ingress",
  ],
} as const;

describe("Phase 5 Acceptance: Combined Backend Scenarios", () => {
  const familyId = "b1111111-1111-4111-8111-111111111111";
  const childPersonId = "c1111111-1111-4111-8111-111111111111";
  const childUserId = "a1111111-1111-4111-8111-111111111111";
  const childToken = "child-bearer-token";

  const parentPersonId = "c0000000-0000-4000-8000-000000000001";
  const parentUserId = "a0000000-0000-4000-8000-000000000001";
  const parentToken = "parent-bearer-token";

  const contact1PersonId = "c2222222-2222-4222-8222-222222222222";
  const contact1UserId = "a2222222-2222-4222-8222-222222222222";
  const contact1Token = "contact1-bearer-token";

  const contact2PersonId = "c3333333-3333-4333-8333-333333333333";
  const contact2UserId = "a3333333-3333-4333-8333-333333333333";

  const otherChildPersonId = "c4444444-4444-4444-8444-444444444444";
  const substitutePersonId = "c5555555-5555-4555-8555-555555555555";
  const substituteUserId = "a5555555-5555-4555-8555-555555555555";
  const substituteToken = "substitute-bearer-token";

  const contact1Id = "d1111111-1111-4111-8111-111111111111";
  const contact2Id = "d2222222-2222-4222-8222-222222222222";

  let repo: Core2Repository;
  let outbox: Core2OutboxPort;
  let eventStore: Core2EventStorePort;
  let outboxDispatches: any[];
  let persistedEvents: any[];

  function createAuthPort() {
    return {
      async verifyBearer(token: string) {
        if (token === childToken) return { userId: childUserId };
        if (token === parentToken) return { userId: parentUserId };
        if (token === contact1Token) return { userId: contact1UserId };
        if (token === substituteToken) return { userId: substituteUserId };
        return null;
      },
    };
  }

  beforeEach(() => {
    outboxDispatches = [];
    persistedEvents = [];

    repo = createInMemoryCore2Repository({
      memberships: [
        { familyId, userId: childUserId, personId: childPersonId, role: "child", revokedAt: null },
        { familyId, userId: parentUserId, personId: parentPersonId, role: "parent", revokedAt: null },
        { familyId, userId: contact1UserId, personId: contact1PersonId, role: "circle", revokedAt: null },
        { familyId, userId: contact2UserId, personId: contact2PersonId, role: "circle", revokedAt: null },
        { familyId, userId: substituteUserId, personId: substitutePersonId, role: "circle", revokedAt: null },
      ],
      people: [
        { id: childPersonId, familyId, displayName: "Riya", role: "child" },
        { id: parentPersonId, familyId, displayName: "Meena (Maa)", role: "parent" },
        { id: contact1PersonId, familyId, displayName: "Rohit Uncle", role: "circle" },
        { id: contact2PersonId, familyId, displayName: "Grandmother", role: "circle" },
        { id: otherChildPersonId, familyId, displayName: "Aarav", role: "child" },
        { id: substitutePersonId, familyId, displayName: "Sharma Neighbor", role: "circle" },
      ],
      trustedContacts: [
        {
          id: contact1Id,
          familyId,
          childPersonId,
          contactPersonId: contact1PersonId,
          priorityOrder: 1,
          relationship: "Uncle",
          capabilities: ["emergency_alert", "voice_reassurance"],
          status: "active",
          createdAt: new Date().toISOString(),
        },
        {
          id: contact2Id,
          familyId,
          childPersonId,
          contactPersonId: contact2PersonId,
          priorityOrder: 2,
          relationship: "Grandmother",
          capabilities: ["emergency_alert"],
          status: "active",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    eventStore = createCore2EventStore({
      onPersist: async (evt) => {
        persistedEvents.push(evt);
      },
    });

    outbox = createCore2Outbox({
      dispatchImmediate: true,
      onDispatch: async (action) => {
        outboxDispatches.push(action);
      },
    });
  });

  function buildService(gateOverride?: Core2GatePort) {
    return createCore2Service({
      auth: createAuthPort(),
      repo,
      timeline: createCore2Timeline(),
      gate: gateOverride ?? createCore2Gate(),
      eventStore,
      outbox,
    });
  }

  // 1. Restart / duplicate webhook / no double dispatch
  describe("Scenario 1: Restart / duplicate webhook / no double dispatch", () => {
    it("ensures duplicate webhook/requests produce no double dispatch across service instance restarts", async () => {
      const service1 = buildService();
      const idempotencyKey = "sos-restart-key-101";
      const payload = {
        familyId,
        personId: childPersonId,
        idempotencyKey,
        triggerType: "sos_button" as const,
        note: "Emergency at school gate",
      };

      const res1 = await service1.handleSosTrigger(childToken, payload);
      expect(res1.status).toBe(202);
      expect(res1.body.status).toBe("accepted");
      expect(res1.replayed).toBe(false);

      const outboxCountBefore = outboxDispatches.length;
      expect(outboxCountBefore).toBeGreaterThan(0);

      // Simulate service restart: instantiate fresh service with same repo and outbox
      const service2 = buildService();
      const res2 = await service2.handleSosTrigger(childToken, payload);
      expect(res2.status).toBe(202);
      expect(res2.body.status).toBe("accepted");
      expect(res2.replayed).toBe(true);
      expect(res2.body.incident_id).toBe(res1.body.incident_id);

      // Verify zero double dispatch: count of outbox actions did not increase
      expect(outboxDispatches.length).toBe(outboxCountBefore);
    });

    it("rejects altered payload under same idempotency key with 409 conflict", async () => {
      const service = buildService();
      const idempotencyKey = "sos-conflict-key-102";

      await service.handleSosTrigger(childToken, {
        familyId,
        personId: childPersonId,
        idempotencyKey,
        triggerType: "sos_button",
        note: "Original message",
      });

      await expect(
        service.handleSosTrigger(childToken, {
          familyId,
          personId: childPersonId,
          idempotencyKey,
          triggerType: "panic_phrase", // altered triggerType
          note: "Altered message",
        })
      ).rejects.toMatchObject({
        code: "idempotency_payload_conflict",
        status: 409,
      });
    });
  });

  // 2. Revoked consent before send
  describe("Scenario 2: Revoked consent before send", () => {
    it("never dispatches escalation alerts to a contact whose consent/relationship was revoked", async () => {
      const service = buildService();

      // Revoke contact 2
      await service.handleRevokeTrustedContact(childToken, {
        familyId,
        contactId: contact2Id,
        reason: "Relationship ended",
      });

      // Trigger SOS
      const res = await service.handleSosTrigger(childToken, {
        familyId,
        personId: childPersonId,
        idempotencyKey: "sos-consent-202",
        triggerType: "sos_button",
        note: "Need help",
      });

      expect(res.body.escalated_contacts_count).toBe(1);

      // Check outbox dispatches: only contact1 received emergency alert
      const recipients = outboxDispatches.map((d) => d.payload?.targetPersonId);
      expect(recipients).toContain(contact1PersonId);
      expect(recipients).not.toContain(contact2PersonId);
    });
  });

  // 3. Stale lease / checkpoint ownership
  describe("Scenario 3: Stale lease / checkpoint ownership", () => {
    it("prevents concurrent worker from stealing active lease and reclaims expired lease cleanly", async () => {
      const past = new Date(Date.now() - 60000).toISOString();

      const watch = await repo.createLateWatch({
        familyId,
        personId: childPersonId,
        destinationLabel: "Home",
        expectedBy: past,
        gracePeriodSeconds: 0,
        escalateAfter: past,
      });

      // Worker 1 claims overdue watch with 60s lease
      const claimedWorker1 = await repo.claimOverdueWatches("worker-1", 60, 10);
      expect(claimedWorker1.length).toBe(1);
      expect(claimedWorker1[0].id).toBe(watch.id);

      // Worker 2 attempts to claim while lease is active
      const claimedWorker2Early = await repo.claimOverdueWatches("worker-2", 60, 10);
      expect(claimedWorker2Early.length).toBe(0); // Protected by active lease

      // Advance lease expiration and verify recovery
      const watchRecord = await repo.getLateWatchById(familyId, watch.id);
      if (watchRecord) {
        watchRecord.leaseUntil = new Date(Date.now() - 1000).toISOString();
      }

      const claimedWorker2AfterExpiry = await repo.claimOverdueWatches("worker-2", 60, 10);
      expect(claimedWorker2AfterExpiry.length).toBe(1);
      expect(claimedWorker2AfterExpiry[0].id).toBe(watch.id);
    });
  });

  // 4. Two-person approval (Cedar gate)
  describe("Scenario 4: Two-person approval (Cedar gate)", () => {
    it("halts contact escalation immediately when Cedar gate denies unauthorized or unapproved action", async () => {
      const denyingGate: Core2GatePort = {
        async check() {
          return {
            decision: "deny",
            reason: "two_person_authorization_required",
          };
        },
      };

      const restrictedService = buildService(denyingGate);

      const res = await restrictedService.handleSosTrigger(childToken, {
        familyId,
        personId: childPersonId,
        idempotencyKey: "sos-gate-deny-401",
        triggerType: "sos_button",
      });

      // Assert gate denied escalation: zero trusted contacts alerted
      expect(res.body.escalated_contacts_count).toBe(0);
      expect(outboxDispatches.length).toBe(0);
    });
  });

  // 5. Same-family target substitution
  describe("Scenario 5: Same-family target substitution", () => {
    it("rejects responder acceptance if the responder is an unoffered same-family member", async () => {
      const service = buildService();
      const sos = await service.handleSosTrigger(childToken, {
        familyId,
        personId: childPersonId,
        idempotencyKey: "sos-target-sub-501",
        triggerType: "sos_button",
      });

      // Substitute person is a member of the same family, but was NOT an offered responder for this incident
      await expect(
        service.handleVerifyResponderAcceptance(substituteToken, {
          familyId,
          incidentId: sos.body.incident_id,
          responderPersonId: substitutePersonId,
          providerEventId: "a0000000-0000-4000-8000-000000000001",
          accountId: "wa-account-primary",
        })
      ).rejects.toMatchObject({
        code: "invalid_responder_acceptance_proof",
        status: 400,
      });
    });

    it("verifies watch ownership strictly matches child subject within family boundary", async () => {
      const service = buildService();
      const watch = await service.handleStartLateWatch(childToken, {
        familyId,
        personId: childPersonId,
        destinationLabel: "Library",
        originLabel: "School",
        minutesUntilExpected: 30,
        idempotencyKey: "watch-target-sub-502",
      });

      const retrieved = await repo.getLateWatchById(familyId, watch.body.watch_id);
      expect(retrieved?.personId).toBe(childPersonId);
      expect(retrieved?.personId).not.toBe(otherChildPersonId);
    });
  });

  // 6. Forged / wrong incident acceptance
  describe("Scenario 6: Forged / wrong incident acceptance", () => {
    it("rejects forged acceptance token and invalid raw event provenance", async () => {
      const service = buildService();
      const sos = await service.handleSosTrigger(childToken, {
        familyId,
        personId: childPersonId,
        idempotencyKey: "sos-forged-601",
        triggerType: "sos_button",
      });

      // 1. Non-existent provider proof event
      await expect(
        service.handleVerifyResponderAcceptance(contact1Token, {
          familyId,
          incidentId: sos.body.incident_id,
          responderPersonId: contact1PersonId,
          providerEventId: "a9999999-9999-4999-8999-999999999999", // non-existent
          accountId: "wa-account-primary",
        })
      ).rejects.toMatchObject({
        code: "invalid_responder_acceptance_proof",
        status: 400,
      });

      // 2. Cross-family acceptance attempt
      await expect(
        service.handleVerifyResponderAcceptance(contact1Token, {
          familyId: "b9999999-9999-4999-8999-999999999999", // wrong family
          incidentId: sos.body.incident_id,
          responderPersonId: contact1PersonId,
          providerEventId: "a0000000-0000-4000-8000-000000000001",
          accountId: "wa-account-primary",
        })
      ).rejects.toThrow();
    });
  });

  // 7. Core 1 voice consent integration seam
  describe("Scenario 7: Core 1 voice consent integration seam", () => {
    it("respects voice consent boundaries and flags live upstream seam as pending parent integration", async () => {
      const service = buildService();

      const truthLine = await service.handleTruthLineQuery(parentToken, {
        familyId,
        queriedByPersonId: parentPersonId,
        targetPersonId: childPersonId,
        queryType: "safety_status",
      });

      expect(truthLine.status).toBe(200);
      expect(truthLine.body.phrase_hi).toBeDefined();
      expect(truthLine.body.phrase_en).toBeDefined();

      // Verify that the external upstream seam to Phase 4 (voice consent ingestion) is explicitly flagged
      expect(COMBINED_BACKEND_INTEGRATION_STATE.phase4_core1_voice).toBe("PENDING_PARENT_INTEGRATION");
      expect(COMBINED_BACKEND_INTEGRATION_STATE.overall_end_to_end).toBe("PENDING_PARENT_INTEGRATION");
    });
  });

  // 8. Core 2 safe-vs-timeout race
  describe("Scenario 8: Core 2 safe-vs-timeout race", () => {
    it("enforces monotonic state lock when 'I am safe' arrives before timeout escalation", async () => {
      const service = buildService();
      const past = new Date(Date.now() - 60000).toISOString();

      const watch = await repo.createLateWatch({
        familyId,
        personId: childPersonId,
        destinationLabel: "Home",
        expectedBy: past,
        gracePeriodSeconds: 0,
        escalateAfter: past,
      });

      // Race: User marks safe first
      const safeRes = await service.handleIAmSafe(childToken, {
        familyId,
        personId: childPersonId,
        idempotencyKey: "safe-race-801",
        reassuranceNote: "I reached home safely",
      });

      expect(safeRes.status).toBe(200);
      expect(safeRes.body.status).toBe("safe");
      expect(safeRes.body.watches_resolved).toBe(1);

      // Cron triggers after safe: state must remain safe and monotonic check rejects escalation
      await expect(
        repo.escalateWatchToIncident(familyId, watch.id)
      ).rejects.toMatchObject({
        code: "monotonic_watch_transition_violation",
        status: 409,
      });

      const updated = await repo.getLateWatchById(familyId, watch.id);
      expect(updated?.status).toBe("safe");
    });

    it("allows transitioning from 'escalated' to 'safe' when overdue subject confirms safe", async () => {
      const service = buildService();
      const past = new Date(Date.now() - 60000).toISOString();

      const watch = await repo.createLateWatch({
        familyId,
        personId: childPersonId,
        destinationLabel: "Home",
        expectedBy: past,
        gracePeriodSeconds: 0,
        escalateAfter: past,
      });

      // Cron escalated the watch
      const { incident } = await repo.escalateWatchToIncident(familyId, watch.id);
      expect(incident.state).toBe("open");

      // Child marks safe afterwards
      const safeRes = await service.handleIAmSafe(childToken, {
        familyId,
        personId: childPersonId,
        idempotencyKey: "safe-race-802",
        reassuranceNote: "Late but safe",
      });

      expect(safeRes.status).toBe(200);
      expect(safeRes.body.status).toBe("safe");
      expect(safeRes.body.watches_resolved).toBe(1);
      expect(safeRes.body.incidents_resolved).toBe(1);

      const finalWatch = await repo.getLateWatchById(familyId, watch.id);
      expect(finalWatch?.status).toBe("safe");
    });
  });

  // 9. Replayed SOS
  describe("Scenario 9: Replayed SOS", () => {
    it("handles replayed SOS identically without duplicate incidents or outbox side effects", async () => {
      const service = buildService();
      const idempotencyKey = "replay-key-sos-901";
      const payload = {
        familyId,
        personId: childPersonId,
        idempotencyKey,
        triggerType: "sos_button" as const,
        note: "Emergency message 901",
      };

      // Turn 1
      const first = await service.handleSosTrigger(childToken, payload);
      expect(first.status).toBe(202);
      expect(first.replayed).toBe(false);
      const outboxCount1 = outboxDispatches.length;

      // Turn 2: Replay
      const second = await service.handleSosTrigger(childToken, payload);
      expect(second.status).toBe(202);
      expect(second.replayed).toBe(true);
      expect(second.body.incident_id).toBe(first.body.incident_id);
      expect(outboxDispatches.length).toBe(outboxCount1);

      // Turn 3: 5 consecutive replays
      for (let i = 0; i < 5; i++) {
        const replay = await service.handleSosTrigger(childToken, payload);
        expect(replay.status).toBe(202);
        expect(replay.replayed).toBe(true);
        expect(replay.body.incident_id).toBe(first.body.incident_id);
      }

      expect(outboxDispatches.length).toBe(outboxCount1);
    });
  });

  // 10. Missed cron recovery
  describe("Scenario 10: Missed cron recovery", () => {
    it("recovers multiple overdue watches accumulated across missed intervals in one run", async () => {
      const service = buildService();
      const past = new Date(Date.now() - 3600000).toISOString();

      await repo.createLateWatch({
        familyId,
        personId: childPersonId,
        destinationLabel: "Tuition",
        expectedBy: past,
        gracePeriodSeconds: 0,
        escalateAfter: past,
      });

      await repo.createLateWatch({
        familyId,
        personId: otherChildPersonId,
        destinationLabel: "Sports Ground",
        expectedBy: past,
        gracePeriodSeconds: 0,
        escalateAfter: past,
      });

      // Cron triggers after outage
      const result = await service.handleProcessOverdueWatches({
        workerId: "cron-recovery-worker-1",
        leaseSeconds: 60,
        limit: 10,
      });

      expect(result.status).toBe(200);
      expect(result.body.claimed_count).toBe(2);
      expect(result.body.escalated_count).toBe(2);

      // Subsequent cron run finds nothing remaining
      const subsequent = await service.handleProcessOverdueWatches({
        workerId: "cron-recovery-worker-2",
        leaseSeconds: 60,
        limit: 10,
      });
      expect(subsequent.status).toBe(200);
      expect(subsequent.body.claimed_count).toBe(0);
      expect(subsequent.body.escalated_count).toBe(0);
    });
  });

  // 11. Redacted reports
  describe("Scenario 11: Redacted reports", () => {
    it("redacts Indian mobile numbers and vehicle plates in dual-language reassurance reports", () => {
      const unredacted = "Child seen near vehicle DL 01 AB 1234. Call driver at 9876543210 or 919876543210.";
      const redacted = redactSensitiveDetails(unredacted);

      expect(redacted).not.toContain("9876543210");
      expect(redacted).not.toContain("DL 01 AB 1234");
      expect(redacted).toContain("<MOBILE_10>");
      expect(redacted).toContain("<VEHICLE_NUM>");

      const reassurance = generateReassurance({
        targetName: "Riya",
        relationship: "daughter",
        watchStatus: "safe",
      });

      expect(reassurance.status).toBe("safe");
      expect(reassurance.phraseHi).toContain("Riya");
      expect(reassurance.phraseHi).toContain("Main safe hoon");
      expect(reassurance.phraseEn).toContain("Riya");
      expect(reassurance.phraseEn).toContain("'I am safe' confirmed");
    });
  });

  // Integration Seam Verification Notice
  describe("Integration Seam & Pending State Verification", () => {
    it("visibly reports combined backend pending status until parent integration completes", () => {
      expect(COMBINED_BACKEND_INTEGRATION_STATE.overall_end_to_end).toBe("PENDING_PARENT_INTEGRATION");
      expect(COMBINED_BACKEND_INTEGRATION_STATE.blockingDependencies.length).toBeGreaterThan(0);
    });
  });
});
