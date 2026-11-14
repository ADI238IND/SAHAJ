import { describe, it, expect } from "vitest";
import {
  createCore2Service,
  createInMemoryCore2Repository,
  createCore2Timeline,
  createCore2Gate,
  createCore2EventStore,
  createCore2Outbox,
} from "@/lib/core2";

describe("Core 2 SOS Trigger & Trusted Contact Escalation", () => {
  const familyId = "b1111111-1111-4111-8111-111111111111";
  const childPersonId = "c1111111-1111-4111-8111-111111111111";
  const childUserId = "a1111111-1111-4111-8111-111111111111";
  const contactPersonId = "c2222222-2222-4222-8222-222222222222";
  const token = "child-bearer-token-1";

  function createTestFixture() {
    const persistedEvents: any[] = [];
    const outboxDispatches: any[] = [];

    const repo = createInMemoryCore2Repository({
      memberships: [
        {
          familyId,
          userId: childUserId,
          personId: childPersonId,
          role: "child",
          revokedAt: null,
        },
      ],
      people: [
        { id: childPersonId, familyId, displayName: "Riya", role: "child" },
        { id: contactPersonId, familyId, displayName: "Rohit", role: "circle" },
      ],
      trustedContacts: [
        {
          id: "tc000000-0000-4000-8000-000000000001",
          familyId,
          childPersonId,
          contactPersonId,
          priorityOrder: 1,
          relationship: "Brother",
          capabilities: ["emergency_alert", "voice_reassurance"],
          status: "active",
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const eventStore = createCore2EventStore({
      onPersist: async (evt) => {
        persistedEvents.push(evt);
      },
    });

    const outbox = createCore2Outbox({
      dispatchImmediate: true,
      onDispatch: async (action) => {
        outboxDispatches.push(action);
      },
    });

    const service = createCore2Service({
      auth: {
        verifyBearer: async (t) => (t === token ? { userId: childUserId } : null),
      },
      repo,
      timeline: createCore2Timeline(),
      gate: createCore2Gate(),
      eventStore,
      outbox,
    });

    return { service, repo, persistedEvents, outboxDispatches };
  }

  it("creates durable incident and escalates to trusted contacts on SOS trigger", async () => {
    const { service, persistedEvents, outboxDispatches } = createTestFixture();

    const res = await service.handleSosTrigger(token, {
      familyId,
      personId: childPersonId,
      idempotencyKey: "sos-test-key-1",
      triggerType: "sos_button",
      locationHint: "Near Metro Station",
    });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("accepted");
    expect(res.body.incident_id).toBeDefined();
    expect(res.body.escalated_contacts_count).toBe(1);
    expect(res.replayed).toBe(false);

    // Verified encrypted raw event persisted before returning 202
    expect(persistedEvents.length).toBe(1);
    expect(persistedEvents[0].familyId).toBe(familyId);
    expect(persistedEvents[0].ciphertext).toMatch(/^v1\./);

    // Verified atomic outbox action queued for trusted contact
    expect(outboxDispatches.length).toBe(1);
    expect(outboxDispatches[0].kind).toBe("core2.sos.alert_trusted_contact");
    expect(outboxDispatches[0].payload.targetPersonId).toBe(contactPersonId);
  });

  it("handles replayed SOS idempotently with same response body", async () => {
    const { service } = createTestFixture();

    const payload = {
      familyId,
      personId: childPersonId,
      idempotencyKey: "sos-test-key-replay",
      triggerType: "sos_button",
    };

    const first = await service.handleSosTrigger(token, payload);
    expect(first.status).toBe(202);
    expect(first.replayed).toBe(false);

    const replay = await service.handleSosTrigger(token, payload);
    expect(replay.status).toBe(202);
    expect(replay.replayed).toBe(true);
    expect(replay.body.incident_id).toBe(first.body.incident_id);
  });

  it("rejects replayed SOS with changed parameters under same idempotency key with 409 conflict", async () => {
    const { service } = createTestFixture();

    await service.handleSosTrigger(token, {
      familyId,
      personId: childPersonId,
      idempotencyKey: "sos-test-conflict-key",
      triggerType: "sos_button",
      locationHint: "First Location",
    });

    await expect(
      service.handleSosTrigger(token, {
        familyId,
        personId: childPersonId,
        idempotencyKey: "sos-test-conflict-key",
        triggerType: "panic_phrase", // Changed body!
        locationHint: "Different Location",
      })
    ).rejects.toMatchObject({
      code: "idempotency_payload_conflict",
      status: 409,
    });
  });

  it("rejects SOS trigger from unauthorized or mismatched person", async () => {
    const { service } = createTestFixture();

    await expect(
      service.handleSosTrigger(token, {
        familyId,
        personId: contactPersonId, // Mismatch with authenticated child
        idempotencyKey: "sos-mismatch-key",
        triggerType: "sos_button",
      })
    ).rejects.toMatchObject({
      code: "actor_person_mismatch",
      status: 403,
    });

    await expect(
      service.handleSosTrigger("invalid-token", {
        familyId,
        personId: childPersonId,
        idempotencyKey: "sos-invalid-token",
        triggerType: "sos_button",
      })
    ).rejects.toMatchObject({
      code: "invalid_credentials",
      status: 401,
    });
  });
});
