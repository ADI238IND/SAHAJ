import { describe, it, expect } from "vitest";
import {
  createCore2Service,
  createInMemoryCore2Repository,
  createCore2Timeline,
  createCore2Gate,
  createCore2EventStore,
  createCore2Outbox,
} from "@/lib/core2";

describe("Core 2 Verified Responder Acceptance", () => {
  const familyId = "b1111111-1111-4111-8111-111111111111";
  const childPersonId = "c1111111-1111-4111-8111-111111111111";
  const childUserId = "a1111111-1111-4111-8111-111111111111";
  const responderPersonId = "c2222222-2222-4222-8222-222222222222";
  const substitutePersonId = "c3333333-3333-4333-8333-333333333333";
  const incidentId = "e0000000-0000-4000-8000-000000000001";
  const providerEventId = "a0000000-0000-4000-8000-000000000001";
  const token = "responder-bearer-token";

  function createTestFixture() {
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
        { id: responderPersonId, familyId, displayName: "Rohit", role: "circle" },
        { id: substitutePersonId, familyId, displayName: "Sharma uncle", role: "circle" },
      ],
      incidents: [
        {
          id: incidentId,
          familyId,
          personId: childPersonId,
          severity: "urgent",
          state: "offered",
          createdAt: new Date().toISOString(),
        },
      ],
      assignments: [
        {
          id: "asg-001",
          familyId,
          incidentId,
          personId: responderPersonId, // Offered specifically to Rohit
          status: "offered",
          offeredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
        },
      ],
      rawEvents: [
        {
          id: providerEventId,
          familyId,
          source: "whatsapp",
          providerEventId: "wa-synth-msg-1",
        },
      ],
    });

    const timeline = createCore2Timeline();
    const originalSign = timeline.signEvent;
    timeline.signEvent = async (entry) => {
      const signed = await originalSign(entry);
      timelineEvents.push(signed);
      return signed;
    };

    const outbox = createCore2Outbox();

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

    return { service, repo, timelineEvents };
  }

  it("verifies and accepts assignment when responder proof binds exact offered responder and incident", async () => {
    const { service, timelineEvents } = createTestFixture();

    const res = await service.handleVerifyResponderAcceptance(token, {
      familyId,
      incidentId,
      responderPersonId,
      providerEventId,
      accountId: "wa-account-primary",
    });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.incident_id).toBe(incidentId);
    expect(res.body.responder_person_id).toBe(responderPersonId);

    // Verify timeline signed
    const accEvent = timelineEvents.find((e) => e.envelope.eventType === "core2.incident.responder_accepted");
    expect(accEvent).toBeDefined();
    expect(accEvent?.envelope.entityId).toBe(incidentId);
  });

  it("rejects forged or wrong incident acceptance", async () => {
    const { service } = createTestFixture();

    await expect(
      service.handleVerifyResponderAcceptance(token, {
        familyId,
        incidentId: "e9999999-9999-4999-8999-999999999999",
        responderPersonId,
        providerEventId,
        accountId: "wa-account-primary",
      })
    ).rejects.toMatchObject({
      code: "invalid_responder_acceptance_proof",
      status: 400,
    });
  });

  it("rejects non-existent provider proof event", async () => {
    const { service } = createTestFixture();

    await expect(
      service.handleVerifyResponderAcceptance(token, {
        familyId,
        incidentId,
        responderPersonId,
        providerEventId: "a9999999-9999-4999-8999-999999999999",
        accountId: "wa-account-primary",
      })
    ).rejects.toMatchObject({
      code: "invalid_responder_acceptance_proof",
      status: 400,
    });
  });

  it("rejects same-family target substitution: unoffered responder cannot accept without offered assignment", async () => {
    const { service } = createTestFixture();

    // Sharma uncle tries to accept an assignment that was offered to Rohit
    await expect(
      service.handleVerifyResponderAcceptance(token, {
        familyId,
        incidentId,
        responderPersonId: substitutePersonId, // Substitute!
        providerEventId,
        accountId: "wa-account-primary",
      })
    ).rejects.toMatchObject({
      code: "invalid_responder_acceptance_proof",
      status: 400,
    });
  });
});
