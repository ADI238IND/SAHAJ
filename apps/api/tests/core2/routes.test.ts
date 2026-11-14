import { describe, it, expect, beforeEach } from "vitest";
import { POST as handleSos } from "@/app/api/core2/sos/route";
import { POST as handleSafe } from "@/app/api/core2/safe/route";
import { POST as handleWatchPost, GET as handleWatchGet } from "@/app/api/core2/watch/route";
import { POST as handleContactsPost, GET as handleContactsGet } from "@/app/api/core2/contacts/route";
import { POST as handleRevokePost } from "@/app/api/core2/contacts/[id]/revoke/route";
import { POST as handleAcceptPost } from "@/app/api/core2/incident/[id]/accept/route";
import { GET as handleTruthLineGet } from "@/app/api/core2/truth-line/route";
import { POST as handleCronPost } from "@/app/api/core2/cron/overdue/route";
import { getDefaultCore2Service, createInMemoryCore2Repository } from "@/lib/core2";

describe("Core 2 Next.js App Router HTTP Endpoints", () => {
  const familyId = "b1111111-1111-4111-8111-111111111111";
  const childPersonId = "c1111111-1111-4111-8111-111111111111";
  const childUserId = "synthetic-auth-user";
  const contactPersonId = "c2222222-2222-4222-8222-222222222222";
  const incidentId = "e0000000-0000-4000-8000-000000000001";
  const rawEventId = "a0000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    // Reset singleton with test repo state
    getDefaultCore2Service({
      repo: createInMemoryCore2Repository({
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
            id: "asg-test-1",
            familyId,
            incidentId,
            personId: contactPersonId,
            status: "offered",
            offeredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
        ],
        rawEvents: [
          {
            id: rawEventId,
            familyId,
            source: "whatsapp",
            providerEventId: "wa-synth-1",
          },
        ],
      }),
    });
  });

  function makeRequest(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers ?? {});
    if (!headers.has("authorization")) {
      headers.set("authorization", "Bearer valid-child-token");
    }
    return new Request(`http://localhost:3000${path}`, {
      ...options,
      headers,
    });
  }

  it("POST /api/core2/sos triggers SOS and returns 202 with security headers", async () => {
    const req = makeRequest("/api/core2/sos", {
      method: "POST",
      body: JSON.stringify({
        familyId,
        personId: childPersonId,
        idempotencyKey: "http-sos-key-1",
        triggerType: "sos_button",
      }),
    });

    const res = await handleSos(req);
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = await res.json();
    expect(json.status).toBe("accepted");
    expect(json.incident_id).toBeDefined();
  });

  it("POST /api/core2/safe records 'Main safe hoon' and returns 200", async () => {
    const req = makeRequest("/api/core2/safe", {
      method: "POST",
      body: JSON.stringify({
        familyId,
        personId: childPersonId,
        idempotencyKey: "http-safe-key-1",
        reassuranceNote: "Main safe hoon",
      }),
    });

    const res = await handleSafe(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("safe");
  });

  it("POST and GET /api/core2/watch creates and retrieves active watch", async () => {
    const createReq = makeRequest("/api/core2/watch", {
      method: "POST",
      body: JSON.stringify({
        familyId,
        personId: childPersonId,
        idempotencyKey: "http-watch-key-1",
        destinationLabel: "Home, HSR Layout",
        minutesUntilExpected: 30,
        gracePeriodMinutes: 5,
      }),
    });

    const createRes = await handleWatchPost(createReq);
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    expect(createJson.status).toBe("active");

    const getReq = makeRequest(`/api/core2/watch?familyId=${familyId}&personId=${childPersonId}`);
    const getRes = await handleWatchGet(getReq);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.active).toBe(true);
    expect(getJson.watch.destinationLabel).toBe("Home, HSR Layout");
  });

  it("POST and GET /api/core2/contacts manages trusted contacts", async () => {
    const postReq = makeRequest("/api/core2/contacts", {
      method: "POST",
      body: JSON.stringify({
        familyId,
        childPersonId,
        contactPersonId,
        relationship: "Brother",
        priorityOrder: 1,
      }),
    });

    const postRes = await handleContactsPost(postReq);
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    expect(postJson.contact_id).toBeDefined();

    const getReq = makeRequest(`/api/core2/contacts?familyId=${familyId}&childPersonId=${childPersonId}`);
    const getRes = await handleContactsGet(getReq);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.contacts.length).toBe(1);
  });

  it("POST /api/core2/contacts/[id]/revoke revokes contact", async () => {
    // Add contact first
    const addReq = makeRequest("/api/core2/contacts", {
      method: "POST",
      body: JSON.stringify({
        familyId,
        childPersonId,
        contactPersonId,
        relationship: "Brother",
        priorityOrder: 1,
      }),
    });
    const addRes = await handleContactsPost(addReq);
    const contactId = (await addRes.json()).contact_id;

    // Revoke
    const revokeReq = makeRequest(`/api/core2/contacts/${contactId}/revoke`, {
      method: "POST",
      body: JSON.stringify({ familyId }),
    });
    const revokeRes = await handleRevokePost(revokeReq, { params: Promise.resolve({ id: contactId }) });
    expect(revokeRes.status).toBe(200);
    const revokeJson = await revokeRes.json();
    expect(revokeJson.status).toBe("revoked");
  });

  it("POST /api/core2/incident/[id]/accept verifies responder acceptance", async () => {
    const acceptReq = makeRequest(`/api/core2/incident/${incidentId}/accept`, {
      method: "POST",
      body: JSON.stringify({
        familyId,
        responderPersonId: contactPersonId,
        providerEventId: rawEventId,
        accountId: "wa-account-test",
      }),
    });

    const acceptRes = await handleAcceptPost(acceptReq, { params: Promise.resolve({ id: incidentId }) });
    expect(acceptRes.status).toBe(200);
    const acceptJson = await acceptRes.json();
    expect(acceptJson.accepted).toBe(true);
  });

  it("GET /api/core2/truth-line returns reassurance phrase", async () => {
    const req = makeRequest(
      `/api/core2/truth-line?familyId=${familyId}&queriedByPersonId=${childPersonId}&targetPersonId=${childPersonId}`
    );
    const res = await handleTruthLineGet(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBeDefined();
    expect(json.phrase_hi).toBeDefined();
    expect(json.phrase_en).toBeDefined();
  });

  it("POST /api/core2/cron/overdue triggers overdue scan", async () => {
    const req = new Request("http://localhost:3000/api/core2/cron/overdue", {
      method: "POST",
      body: JSON.stringify({ workerId: "test-cron-worker" }),
      headers: { "content-type": "application/json" },
    });
    const res = await handleCronPost(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.claimed_count).toBeDefined();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const unauthReq = new Request("http://localhost:3000/api/core2/sos", {
      method: "POST",
      body: JSON.stringify({
        familyId,
        personId: childPersonId,
        idempotencyKey: "unauth-key-1",
        triggerType: "sos_button",
      }),
      headers: { "content-type": "application/json" },
    });
    const res = await handleSos(unauthReq);
    expect(res.status).toBe(401);
  });
});
