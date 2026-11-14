import { describe, it, expect } from "vitest";
import {
  createCore2Service,
  createInMemoryCore2Repository,
  createCore2Timeline,
  createCore2Gate,
  createCore2EventStore,
  createCore2Outbox,
  generateReassurance,
  redactSensitiveDetails,
} from "@/lib/core2";

describe("Core 2 Maa's Truth-Line & Redacted Family Reassurance", () => {
  const familyId = "b1111111-1111-4111-8111-111111111111";
  const parentPersonId = "c0000000-0000-4000-8000-000000000001";
  const parentUserId = "a0000000-0000-4000-8000-000000000001";
  const childPersonId = "c1111111-1111-4111-8111-111111111111";
  const watchId = "11111111-1111-4111-8111-111111111111";
  const token = "parent-bearer-token";

  function createTestFixture() {
    const repo = createInMemoryCore2Repository({
      memberships: [
        {
          familyId,
          userId: parentUserId,
          personId: parentPersonId,
          role: "parent",
          revokedAt: null,
        },
      ],
      people: [
        { id: parentPersonId, familyId, displayName: "Meena (Maa)", role: "parent" },
        { id: childPersonId, familyId, displayName: "Riya", role: "child" },
      ],
      watches: [
        {
          id: watchId,
          familyId,
          personId: childPersonId,
          destinationLabel: "Home, HSR Layout",
          expectedBy: new Date(Date.now() + 25 * 60000).toISOString(),
          gracePeriodSeconds: 300,
          escalateAfter: new Date(Date.now() + 30 * 60000).toISOString(),
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const service = createCore2Service({
      auth: {
        verifyBearer: async (t) => (t === token ? { userId: parentUserId } : null),
      },
      repo,
      timeline: createCore2Timeline(),
      gate: createCore2Gate(),
      eventStore: createCore2EventStore(),
      outbox: createCore2Outbox(),
    });

    return { service, repo };
  }

  it("redacts 10-digit mobile numbers and vehicle plates from reassurance reports", () => {
    const raw = "Riya in cab KA 05 AB 1234, driver contact 9876543210 and OTP 123456";
    const redacted = redactSensitiveDetails(raw);
    expect(redacted).not.toContain("9876543210");
    expect(redacted).toContain("<MOBILE_10>");
    expect(redacted).not.toContain("KA 05 AB 1234");
    expect(redacted).toContain("<VEHICLE_NUM>");
    expect(redacted).not.toContain("123456");
    expect(redacted).toContain("<NUM>");
  });

  it("returns monitoring status in Hindi and English when Late Watch is active", async () => {
    const { service } = createTestFixture();

    const res = await service.handleTruthLineQuery(token, {
      familyId,
      queriedByPersonId: parentPersonId,
      targetPersonId: childPersonId,
      queryType: "safety_status",
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("monitoring");
    expect(res.body.phrase_hi).toContain("Riya raaste mein hain");
    expect(res.body.phrase_en).toContain("Riya is on the way");
  });

  it("returns safe confirmation when child has confirmed 'Main safe hoon'", () => {
    const reassurance = generateReassurance({
      targetName: "Riya",
      relationship: "daughter",
      watchStatus: "safe",
    });

    expect(reassurance.status).toBe("safe");
    expect(reassurance.phraseHi).toContain("Main safe hoon");
    expect(reassurance.phraseEn).toContain("'I am safe' confirmed");
  });

  it("returns consent-respecting operational fallback when consent is revoked", () => {
    const reassurance = generateReassurance({
      targetName: "Riya",
      relationship: "daughter",
      watchStatus: "active",
      destination: "Secret Location",
      consentRevoked: true,
    });

    expect(reassurance.status).toBe("monitoring");
    expect(reassurance.redacted).toBe(true);
    expect(reassurance.phraseHi).toContain("parivar ke designated sadasya se sampark karein");
    expect(reassurance.phraseEn).toContain("designated family contact");
    // Does NOT leak destination when consent is revoked
    expect(reassurance.phraseHi).not.toContain("Secret Location");
    expect(reassurance.phraseEn).not.toContain("Secret Location");
  });
});
