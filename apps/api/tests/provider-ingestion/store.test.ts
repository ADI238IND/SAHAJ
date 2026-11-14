import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpc = vi.fn();
const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
let row: unknown = { family_id: "f", person_id: "p" };
let failure: unknown = null;
vi.mock("../../src/lib/database", () => ({
  serviceDatabase: () => ({
    rpc,
    from: (table: string) => {
      const entry = { table, filters: {} as Record<string, unknown> };
      calls.push(entry);
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (k: string, v: unknown) => { entry.filters[k] = v; return q; },
        is: (k: string, v: unknown) => { entry.filters[k] = v; return q; },
        maybeSingle: async () => ({ data: row, error: failure }),
      };
      return q;
    },
  }),
}));

import { providerStore } from "../../src/lib/provider-ingestion/store";
import { decryptWebhook, identityHash } from "../../src/lib/webhook-security";

const KEY = "ab".repeat(32), ID_SECRET = "i".repeat(40);
beforeEach(() => {
  rpc.mockReset(); calls.length = 0; row = { family_id: "f", person_id: "p" }; failure = null;
  vi.stubEnv("WEBHOOK_ENCRYPTION_KEY", KEY); vi.stubEnv("IDENTITY_HASH_SECRET", ID_SECRET);
});
afterEach(() => vi.unstubAllEnvs());

const event = { source: "sarvam" as const, id: "app:outbound:a:connected", type: "sarvam.outbound", status: "connected", familyId: "f", personId: "p", payload: { attempt_id: "a", status: "connected" } };

it("fails closed when encryption or identity secrets are missing", () => {
  vi.stubEnv("WEBHOOK_ENCRYPTION_KEY", "");
  expect(() => providerStore()).toThrow();
});
it("writes an encrypted payload and enum-only metadata through ingest_raw_event", async () => {
  rpc.mockResolvedValue({ data: {}, error: null });
  await providerStore().ingest(event);
  const [name, args] = rpc.mock.calls[0];
  expect(name).toBe("ingest_raw_event");
  expect(args.p_metadata).toEqual({ person_id: "p", status: "connected" });
  expect(args.p_payload_ciphertext).not.toContain("attempt_id");
  expect(JSON.parse(decryptWebhook(args.p_payload_ciphertext, KEY, `sarvam:${event.id}`).toString())).toEqual(event.payload);
});
it("maps unique violations to 409 and other failures to 503", async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { code: "23505" } });
  await expect(providerStore().ingest(event)).rejects.toMatchObject({ status: 409, code: "event_id_conflict" });
  rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "secret detail" } });
  await expect(providerStore().ingest(event)).rejects.toMatchObject({ status: 503, code: "event_persistence_failed" });
});
it("looks up attempts by hash, app, binding kind and active flags", async () => {
  expect(await providerStore().findSarvamAttempt("app-1", "att-1")).toEqual({ familyId: "f", personId: "p" });
  expect(calls[0].filters).toMatchObject({
    source: "sarvam", account_id: "app-1", binding_kind: "attempt", attempt_id: "att-1", agent_id: "app-1", enabled: true, revoked_at: null,
    external_id_hash: identityHash("sarvam", "app-1", "att-1", ID_SECRET),
  });
});
it("returns null for unknown identities and throws 503 on lookup errors", async () => {
  row = null;
  expect(await providerStore().resolveContact("telecmi", "123", "919876543210")).toBeNull();
  expect(await providerStore().findTwilioCall("CA1")).toBeNull();
  failure = { code: "x" };
  await expect(providerStore().resolveContact("telecmi", "123", "9")).rejects.toMatchObject({ status: 503 });
});
it("derives consent flags from the calls row", async () => {
  row = { family_id: "f", person_id: "p", ai_disclosed_at: "2026-01-01", recording_consent_at: null };
  expect(await providerStore().findTwilioCall("CA1")).toMatchObject({ aiDisclosed: true, recordingConsent: false });
  expect(calls[0].filters).toMatchObject({ provider: "twilio", external_id: "CA1" });
});
