import { describe, expect, it } from "vitest";
import { handleTwilioRecording, handleTwilioStatus, verifyTwilioSignature, type TwilioConfig } from "../../src/lib/provider-ingestion/gateway";
import { ACCOUNT_SID, AUTH, CALL_SID, fakeStore, FAMILY, RECORDING_URL, REC_SID, STATUS_URL, twilioSign } from "./helpers";

const cfg: TwilioConfig = { accountSid: ACCOUNT_SID, authToken: AUTH, statusUrl: STATUS_URL, recordingUrl: RECORDING_URL };
const FORM = "application/x-www-form-urlencoded";
const statusForm = (o: Record<string, string> = {}) => new URLSearchParams({ AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: "completed", SequenceNumber: "3", ...o });
const recForm = (o: Record<string, string> = {}) => new URLSearchParams({ AccountSid: ACCOUNT_SID, CallSid: CALL_SID, RecordingSid: REC_SID, RecordingStatus: "completed", RecordingDuration: "42", RecordingUrl: "https://api.twilio.com/secret-recording", ...o });
const send = (h: typeof handleTwilioStatus, form: URLSearchParams, url: string, store = fakeStore(), c = cfg, sig?: string | null, type: string | null = FORM) =>
  h(Buffer.from(form.toString()), type, sig === undefined ? twilioSign(url, form) : sig, c, () => store);

describe("twilio signature", () => {
  it("matches Twilio's documented algorithm and rejects tampering", () => {
    const p = new URLSearchParams({ B: "2", A: "1", C: "x" });
    expect(verifyTwilioSignature(STATUS_URL, p, twilioSign(STATUS_URL, p), AUTH)).toBe(true);
    expect(verifyTwilioSignature(STATUS_URL, p, twilioSign(STATUS_URL, p), "other-token")).toBe(false);
    expect(verifyTwilioSignature("https://evil.example.test/x", p, twilioSign(STATUS_URL, p), AUTH)).toBe(false);
    expect(verifyTwilioSignature(STATUS_URL, new URLSearchParams({ A: "1", B: "3", C: "x" }), twilioSign(STATUS_URL, p), AUTH)).toBe(false);
    expect(verifyTwilioSignature("http://api.example.test/x", p, twilioSign("http://api.example.test/x", p), AUTH)).toBe(false);
    for (const s of [null, "", "short", "!!!"]) expect(verifyTwilioSignature(STATUS_URL, p, s, AUTH)).toBe(false);
  });
});

describe("twilio status", () => {
  it("persists IDs and enums for a known call", async () => {
    const store = fakeStore();
    const r = await send(handleTwilioStatus, statusForm(), STATUS_URL, store);
    expect(r.status).toBe(200);
    expect(store.findTwilioCall).toHaveBeenCalledWith(CALL_SID);
    expect(store.ingest.mock.calls[0][0]).toMatchObject({ source: "twilio", id: `${ACCOUNT_SID}:call:${CALL_SID}:completed:3`, type: "twilio.call_status", familyId: FAMILY });
  });
  it("rejects bad or missing signature before any lookup", async () => {
    for (const sig of [null, "AAAA", twilioSign(STATUS_URL, statusForm(), "wrong-token"), twilioSign(RECORDING_URL, statusForm())]) {
      const store = fakeStore();
      await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, store, cfg, sig)).rejects.toMatchObject({ status: 401 });
      expect(store.findTwilioCall).not.toHaveBeenCalled();
    }
  });
  it("fails closed when URL or credentials are not configured, and on wrong content type", async () => {
    await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, fakeStore(), { ...cfg, statusUrl: undefined })).rejects.toMatchObject({ status: 503 });
    await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, fakeStore(), { ...cfg, authToken: "" })).rejects.toMatchObject({ status: 503 });
    await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, fakeStore(), cfg, undefined, "application/json")).rejects.toMatchObject({ status: 415 });
  });
  it("rejects wrong account, unknown call, malformed, and duplicate parameters", async () => {
    const wrong = "AC" + "d".repeat(32);
    await expect(send(handleTwilioStatus, statusForm({ AccountSid: wrong }), STATUS_URL)).rejects.toMatchObject({ status: 403, code: "wrong_provider_account" });
    const unknown = fakeStore({ findTwilioCall: async () => null });
    await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, unknown)).rejects.toMatchObject({ status: 403, code: "unknown_call" });
    expect(unknown.ingest).not.toHaveBeenCalled();
    await expect(send(handleTwilioStatus, statusForm({ CallStatus: "bogus" }), STATUS_URL)).rejects.toMatchObject({ status: 400 });
    await expect(send(handleTwilioStatus, statusForm({ CallSid: "CAx" }), STATUS_URL)).rejects.toMatchObject({ status: 400 });
    const dup = statusForm(); dup.append("CallStatus", "failed");
    await expect(send(handleTwilioStatus, dup, STATUS_URL)).rejects.toMatchObject({ status: 400 });
  });
  it("does not acknowledge on persistence failure", async () => {
    const { WebhookError } = await import("../../src/lib/webhook-security");
    const store = fakeStore({ ingest: async () => { throw new WebhookError("event_persistence_failed", 503); } });
    await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, store)).rejects.toMatchObject({ status: 503 });
  });
});

describe("twilio recording", () => {
  it("queues retrieval only after identity and consent, without storing the media URL", async () => {
    const store = fakeStore();
    const r = await send(handleTwilioRecording, recForm(), RECORDING_URL, store);
    expect(r.body).toEqual({ accepted: true, processing: "queued" });
    const event = store.ingest.mock.calls[0][0];
    expect(event).toMatchObject({ type: "twilio.recording.retrieval_requested", id: `${ACCOUNT_SID}:recording:${REC_SID}:completed` });
    expect(JSON.stringify(event)).not.toContain("secret-recording");
    expect(JSON.stringify(r)).not.toMatch(/deliver|heard|stored/i);
  });
  it("rejects recordings without AI disclosure or recording consent, with no write", async () => {
    for (const flags of [{ aiDisclosed: true, recordingConsent: false }, { aiDisclosed: false, recordingConsent: true }]) {
      const store = fakeStore({ findTwilioCall: async () => ({ familyId: FAMILY, personId: "p", ...flags }) });
      await expect(send(handleTwilioRecording, recForm(), RECORDING_URL, store)).rejects.toMatchObject({ status: 403, code: "recording_consent_missing" });
      expect(store.ingest).not.toHaveBeenCalled();
    }
  });
  it("uses the recording URL for signatures, so status signatures cannot be replayed here", async () => {
    await expect(send(handleTwilioRecording, recForm(), STATUS_URL)).rejects.toMatchObject({ status: 401 });
  });
  it("records non-completed statuses as status events, not retrieval requests", async () => {
    const store = fakeStore();
    await send(handleTwilioRecording, recForm({ RecordingStatus: "failed" }), RECORDING_URL, store);
    expect(store.ingest.mock.calls[0][0].type).toBe("twilio.recording.status");
  });
  it("rejects wrong account, unknown call, malformed fields", async () => {
    await expect(send(handleTwilioRecording, recForm({ AccountSid: "AC" + "e".repeat(32) }), RECORDING_URL)).rejects.toMatchObject({ status: 403 });
    await expect(send(handleTwilioRecording, recForm({ RecordingSid: "RE1" }), RECORDING_URL)).rejects.toMatchObject({ status: 400 });
    await expect(send(handleTwilioRecording, recForm({ RecordingStatus: "x" }), RECORDING_URL)).rejects.toMatchObject({ status: 400 });
    await expect(send(handleTwilioRecording, recForm({ RecordingDuration: "-1" }), RECORDING_URL)).rejects.toMatchObject({ status: 400 });
    const unknown = fakeStore({ findTwilioCall: async () => null });
    await expect(send(handleTwilioRecording, recForm(), RECORDING_URL, unknown)).rejects.toMatchObject({ status: 403 });
  });
});
