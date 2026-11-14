import { describe, it, expect } from "vitest";
import {
  createCore2Service,
  createInMemoryCore2Repository,
  createCore2Timeline,
  createCore2Gate,
  createCore2EventStore,
  createCore2Outbox,
} from "@/lib/core2";

describe("Core 2 Trusted Contacts Lifecycle & Revocation", () => {
  const familyId = "b1111111-1111-4111-8111-111111111111";
  const childPersonId = "c1111111-1111-4111-8111-111111111111";
  const childUserId = "a1111111-1111-4111-8111-111111111111";
  const contactPersonId = "c2222222-2222-4222-8222-222222222222";
  const token = "child-bearer-token-tc";

  function createTestFixture() {
    const outboxActions: any[] = [];
    const timelineEvents: any[] = [];

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
    });

    const outbox = createCore2Outbox({
      dispatchImmediate: true,
      onDispatch: async (act) => {
        outboxActions.push(act);
      },
    });

    const timeline = createCore2Timeline();
    const originalSign = timeline.signEvent;
    timeline.signEvent = async (entry) => {
      const signed = await originalSign(entry);
      timelineEvents.push(signed);
      return signed;
    };

    const service = createCore2Service({
      auth: {
        verifyBearer: async (t) => (t === token ? { userId: childUserId } : null),
      },
      repo,
      timeline,
      gate: createCore2Gate(),
      eventStore: createCore2EventStore(),
      outbox,
    });

    return { service, repo, outboxActions, timelineEvents };
  }

  it("adds and lists trusted contacts in priority order", async () => {
    const { service } = createTestFixture();

    const addRes = await service.handleAddTrustedContact(token, {
      familyId,
      childPersonId,
      contactPersonId,
      relationship: "Brother",
      priorityOrder: 1,
      capabilities: ["emergency_alert", "voice_reassurance"],
    });

    expect(addRes.status).toBe(201);
    expect(addRes.body.contact_id).toBeDefined();
    expect(addRes.body.priority_order).toBe(1);

    const listRes = await service.handleListTrustedContacts(token, familyId, childPersonId);
    expect(listRes.status).toBe(200);
    expect(listRes.body.contacts.length).toBe(1);
    expect(listRes.body.contacts[0].relationship).toBe("Brother");
  });

  it("revokes trusted contact and signs revocation in timeline", async () => {
    const { service, timelineEvents } = createTestFixture();

    const addRes = await service.handleAddTrustedContact(token, {
      familyId,
      childPersonId,
      contactPersonId,
      relationship: "Brother",
      priorityOrder: 1,
    });

    const contactId = addRes.body.contact_id;

    const revokeRes = await service.handleRevokeTrustedContact(token, {
      familyId,
      contactId,
      reason: "No longer primary responder",
    });

    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.status).toBe("revoked");
    expect(revokeRes.body.revoked_at).toBeDefined();

    // Verify contact is no longer listed as active
    const listRes = await service.handleListTrustedContacts(token, familyId, childPersonId);
    expect(listRes.body.contacts.length).toBe(0);

    // Verify revocation timeline event was signed
    const revEvent = timelineEvents.find((e) => e.envelope.eventType === "core2.trusted_contact.revoked");
    expect(revEvent).toBeDefined();
  });

  it("revoked contact before send: excluded from emergency escalation", async () => {
    const { service, outboxActions } = createTestFixture();

    // 1. Add contact
    const addRes = await service.handleAddTrustedContact(token, {
      familyId,
      childPersonId,
      contactPersonId,
      relationship: "Brother",
      priorityOrder: 1,
    });

    // 2. Revoke contact before SOS is triggered
    await service.handleRevokeTrustedContact(token, {
      familyId,
      contactId: addRes.body.contact_id,
    });

    // 3. Trigger SOS
    const sosRes = await service.handleSosTrigger(token, {
      familyId,
      personId: childPersonId,
      idempotencyKey: "sos-revoked-contact-test",
      triggerType: "sos_button",
    });

    expect(sosRes.status).toBe(202);
    // Escalated contacts count must be 0 because the only contact was revoked
    expect(sosRes.body.escalated_contacts_count).toBe(0);
    expect(outboxActions.length).toBe(0);
  });
});
