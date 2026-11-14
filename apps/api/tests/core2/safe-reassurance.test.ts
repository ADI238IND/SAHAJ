import { describe, it, expect } from "vitest";
import {
  createCore2Service,
  createInMemoryCore2Repository,
  createCore2Timeline,
  createCore2Gate,
  createCore2EventStore,
  createCore2Outbox,
} from "@/lib/core2";

describe("Core 2 'I am safe' Reassurance & Monotonic State Transitions", () => {
  const familyId = "b1111111-1111-4111-8111-111111111111";
  const childPersonId = "c1111111-1111-4111-8111-111111111111";
  const childUserId = "a1111111-1111-4111-8111-111111111111";
  const watchId = "11111111-1111-4111-8111-111111111111";
  const incidentId = "e1111111-1111-4111-8111-111111111111";
  const token = "child-bearer-token-safe";

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
      ],
      watches: [
        {
          id: watchId,
          familyId,
          personId: childPersonId,
          destinationLabel: "Home, HSR Layout",
          expectedBy: new Date(Date.now() + 30 * 60000).toISOString(),
          gracePeriodSeconds: 300,
          escalateAfter: new Date(Date.now() + 35 * 60000).toISOString(),
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      sosTriggers: [
        {
          id: "d1111111-1111-4111-8111-111111111111",
          familyId,
          personId: childPersonId,
          incidentId,
          idempotencyKey: "sos-key-1",
          payloadHash: "a".repeat(64),
          triggerType: "sos_button",
          status: "triggered",
          createdAt: new Date().toISOString(),
        },
      ],
      incidents: [
        {
          id: incidentId,
          familyId,
          personId: childPersonId,
          severity: "urgent",
          state: "open",
          createdAt: new Date().toISOString(),
        },
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

  it("monotonically resolves active late watches and open incidents to safe", async () => {
    const { service, repo, outboxActions, timelineEvents } = createTestFixture();

    const res = await service.handleIAmSafe(token, {
      familyId,
      personId: childPersonId,
      idempotencyKey: "safe-req-1",
      reassuranceNote: "Maa, main ghar pahunch gayi. Bilkul safe hoon.",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("safe");
    expect(res.body.watches_resolved).toBe(1);
    expect(res.body.incidents_resolved).toBe(1);

    // Verify repository state
    const watch = await repo.getLateWatchById(familyId, watchId);
    expect(watch?.status).toBe("safe");
    expect(watch?.safeAt).toBeDefined();

    // Verify outbox reassurance broadcast
    expect(outboxActions.length).toBe(1);
    expect(outboxActions[0].kind).toBe("core2.family.reassurance_broadcast");

    // Verify timeline signed
    expect(timelineEvents.length).toBe(1);
    expect(timelineEvents[0].envelope.eventType).toBe("core2.child.safe_confirmed");
    expect(timelineEvents[0].signature).toBeDefined();
  });

  it("handles repeated 'I am safe' calls idempotently without duplicate outbox broadcasts", async () => {
    const { service, outboxActions } = createTestFixture();

    const payload = {
      familyId,
      personId: childPersonId,
      idempotencyKey: "safe-req-repeat",
      reassuranceNote: "Main safe hoon",
    };

    const first = await service.handleIAmSafe(token, payload);
    expect(first.status).toBe(200);
    expect(first.replayed).toBe(false);
    expect(outboxActions.length).toBe(1);

    const repeat = await service.handleIAmSafe(token, payload);
    expect(repeat.status).toBe(200);
    expect(repeat.replayed).toBe(true);
    expect(outboxActions.length).toBe(1);
  });

  it("safe-vs-timeout race: once marked safe, late watch cannot be downgraded to escalated", async () => {
    const { service, repo } = createTestFixture();

    // 1. Mark safe first
    await service.handleIAmSafe(token, {
      familyId,
      personId: childPersonId,
      idempotencyKey: "safe-race-key",
      reassuranceNote: "Safe before timeout",
    });

    // 2. Simulate late watch escalation attempt (e.g. from overdue cron)
    await expect(
      repo.escalateWatchToIncident(familyId, watchId)
    ).rejects.toMatchObject({
      code: "monotonic_watch_transition_violation",
      status: 409,
    });

    // Verify status remains safe
    const watch = await repo.getLateWatchById(familyId, watchId);
    expect(watch?.status).toBe("safe");
  });
});
