import { createHmac } from "node:crypto";
import { vi } from "vitest";
import type { ProviderStore } from "../../src/lib/provider-ingestion/gateway";

export const ACCOUNT_SID = "AC" + "a".repeat(32);
export const CALL_SID = "CA" + "b".repeat(32);
export const REC_SID = "RE" + "c".repeat(32);
export const AUTH = "synthetic-twilio-token";
export const STATUS_URL = "https://api.example.test/api/twilio/status";
export const RECORDING_URL = "https://api.example.test/api/twilio/recording";
export const FAMILY = "11111111-1111-4111-8111-111111111111";
export const PERSON = "22222222-2222-4222-8222-222222222222";

export function fakeStore(over: Partial<ProviderStore> = {}) {
  const base = {
    findSarvamAttempt: vi.fn<ProviderStore["findSarvamAttempt"]>(async () => ({ familyId: FAMILY, personId: PERSON })),
    resolveContact: vi.fn<ProviderStore["resolveContact"]>(async () => ({ familyId: FAMILY, personId: PERSON })),
    findTwilioCall: vi.fn<ProviderStore["findTwilioCall"]>(async () => ({ familyId: FAMILY, personId: PERSON, aiDisclosed: true, recordingConsent: true })),
    ingest: vi.fn<ProviderStore["ingest"]>(async () => {}),
  };
  return Object.assign(base, over) as typeof base;
}

export function twilioSign(url: string, params: URLSearchParams, token = AUTH) {
  let data = url;
  for (const k of [...new Set(params.keys())].sort()) for (const v of params.getAll(k).sort()) data += k + v;
  return createHmac("sha1", token).update(data).digest("base64");
}

export const outbound = (o: Record<string, unknown> = {}) => ({
  attempt_id: "att-1", app_id: "app-1", app_version: 2, status: "connected", duration: 12.5,
  interaction_id: "20261114/abc123", failure_reason: null,
  channel_info: { agent_phone_number: "+91 80000 00000" },
  transcript: "SYNTHETIC-SECRET-TRANSCRIPT", user_phone_number: "+919999999999", ...o,
});
export const inbound = (o: Record<string, unknown> = {}) => ({
  interaction_id: "20261114/in-1", deployment_id: "dep-1", app_id: "app-1",
  user_phone_number: "+919876543210", agent_phone_number: "+918000000000", duration: 30,
  start_datetime: "2026-11-14T10:00:00Z", end_datetime: "2026-11-14T10:00:30Z", transcript: "SYNTHETIC-SECRET-TRANSCRIPT", ...o,
});
export const missed = (o: Record<string, unknown> = {}) => ({
  type: "cdr", direction: "inbound", status: "missed", appid: 123, virtual_number: "918000000001",
  cmiuuid: "cmi-uuid-0001", from: "919876543210", time: 1_794_000_000_000, ...o,
});
