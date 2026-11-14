import { describe, it, expect } from "vitest";
import {
  createCore2Service,
  createInMemoryCore2Repository,
  createCore2Timeline,
  createCore2Gate,
  createCore2EventStore,
  createCore2Outbox,
} from "@/lib/core2";

describe("Core 2 Late-Home Watch & Missed Cron Recovery", () => {
  const familyId = "b1111111-1111-4111-8111-111111111111";
  const childPersonId = "c1111111-1111-4111-8111-111111111111";
  const childUserId = "a1111111-1111-4111-8111-111111111111";
  const contactPersonId = "c2222222-2222-4222-8222-222222222222";
  const token = "child-bearer-token-watch";

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
      trustedContacts: [
        {
          id: "d0000000-0000-4000-8000-000000000001",
          familyId,
          childPersonId,
          contactPersonId,
          priorityOrder: 1,
          relationship: "Brother",
          capabilities: ["emergency_alert"],
          status: "active",
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

  it("schedules late-home watch with bounded destination and grace period", async () => {
    const { service } = createTestFixture();

    const res = await service.handleStartLateWatch(token, {
      familyId,
      personId: childPersonId,
      idempotencyKey: "watch-key-1",
      destinationLabel: "Home, HSR Layout",
      originLabel: "Office, Koramangala",
      transportNote: "Uber · KA 05 AB 1234",
      minutesUntilExpected: 30,
      gracePeriodMinutes: 5,
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("active");
    expect(res.body.watch_id).toBeDefined();

    const active = await service.handleGetActiveWatch(token, familyId, childPersonId);
    expect(active.status).toBe(200);
    expect(active.body.active).toBe(true);
    expect(active.body.watch?.destinationLabel).toBe("Home, HSR Layout");
  });

  it("recovers overdue watches during cron execution without double dispatch", async () => {
    const { service, repo, outboxActions } = createTestFixture();

    // Create an overdue watch directly in repo (expected in the past)
    const overdueTime = new Date(Date.now() - 10 * 60000).toISOString();
    await repo.createLateWatch({
      familyId,
      personId: childPersonId,
      destinationLabel: "Home, HSR Layout",
      expectedBy: overdueTime,
      gracePeriodSeconds: 300,
      escalateAfter: new Date(Date.now() - 5 * 60000).toISOString(),
    });

    // Run cron overdue recovery
    const cronRes1 = await service.handleProcessOverdueWatches({
      workerId: "worker-cron-1",
      leaseSeconds: 60,
      limit: 10,
    });

    expect(cronRes1.status).toBe(200);
    expect(cronRes1.body.claimed_count).toBe(1);
    expect(cronRes1.body.escalated_count).toBe(1);
    expect(outboxActions.length).toBe(1);

    // Immediate second run (simulating duplicate webhook / cron tick) must NOT double dispatch
    const cronRes2 = await service.handleProcessOverdueWatches({
      workerId: "worker-cron-2",
      leaseSeconds: 60,
      limit: 10,
    });

    expect(cronRes2.status).toBe(200);
    // Already escalated / leased: claimed count is 0
    expect(cronRes2.body.claimed_count).toBe(0);
    expect(cronRes2.body.escalated_count).toBe(0);
    expect(outboxActions.length).toBe(1);
  });

  it("handles stale lease ownership: expired lease allows another worker to claim", async () => {
    const { repo } = createTestFixture();

    // Create overdue watch with an EXPIRED lease
    const watch = await repo.createLateWatch({
      familyId,
      personId: childPersonId,
      destinationLabel: "Home",
      expectedBy: new Date(Date.now() - 20 * 60000).toISOString(),
      gracePeriodSeconds: 0,
      escalateAfter: new Date(Date.now() - 20 * 60000).toISOString(),
    });

    // Worker 1 took a lease that expired 5 minutes ago
    const watchRecord = await repo.getLateWatchById(familyId, watch.id);
    if (watchRecord) {
      watchRecord.leaseToken = "c0000000-0000-4000-8000-000000000001";
      watchRecord.leaseUntil = new Date(Date.now() - 5 * 60000).toISOString();
      watchRecord.workerId = "stale-worker";
    }

    // Worker 2 should successfully claim it because the lease is stale
    const claimed = await repo.claimOverdueWatches("new-worker-2", 60, 5);
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(watch.id);
    expect(claimed[0].workerId).toBe("new-worker-2");
  });
});
