import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookError } from "../webhook-security";
import {
  isRecord, parseSarvamInbound, parseSarvamOutbound, parseTeleCmiMissed, parseTwilioRecording, parseTwilioStatus, phoneDigits,
} from "./parsers";

export interface Identity { familyId: string; personId: string }
export interface ProviderEvent {
  source: "sarvam" | "telecmi" | "twilio";
  id: string; type: string; status: string; familyId: string; personId: string;
  /** Allowlisted IDs, enums and counters only. Encrypted by the store before it leaves the process. */
  payload: Record<string, string | number | null>;
}
/** Every method must throw WebhookError (503 on infrastructure failure) or return null for "unknown". */
export interface ProviderStore {
  /** Server-stored Sarvam outbound attempt for this app (provider_identities, binding_kind 'attempt'). */
  findSarvamAttempt(appId: string, attemptId: string): Promise<Identity | null>;
  /** Registered caller (provider_identities, binding_kind 'contact'). externalId is phone digits. */
  resolveContact(source: "sarvam" | "telecmi", account: string, externalId: string): Promise<Identity | null>;
  /** calls row with provider 'twilio' and external_id = CallSid. */
  findTwilioCall(callSid: string): Promise<(Identity & { aiDisclosed: boolean; recordingConsent: boolean }) | null>;
  /** Must resolve only after ingest_raw_event has durably committed. */
  ingest(event: ProviderEvent): Promise<void>;
}

export interface SarvamConfig { appId: string; agentDigits: string; deploymentId?: string }
export interface TeleCmiConfig { appId: number; virtualDigits: string }
export interface TwilioConfig { accountSid: string; authToken: string; statusUrl?: string; recordingUrl?: string }
export interface GatewayResult { status: number; body: Record<string, unknown> }

const reject = (code: string, status: number): never => { throw new WebhookError(code, status); };
const accepted = (): GatewayResult => ({ status: 200, body: { accepted: true, processing: "queued" } });

export function toResult(error: unknown): GatewayResult {
  if (error instanceof WebhookError) return { status: error.status, body: { error: error.code } };
  return { status: 503, body: { error: "event_persistence_failed" } };
}

function json(raw: Buffer): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); } catch { return reject("invalid_json", 400); }
  if (!isRecord(value)) return reject("invalid_payload", 400);
  return value;
}

/**
 * Sarvam post-call webhook. Sarvam sends no signature, so the URL secret is only a gate. Sender identity
 * rests on configured app/agent/deployment plus either a server-stored attempt (outbound) or a
 * registered caller (inbound). Provider IDs alone never authenticate a sender.
 */
export async function handleSarvam(raw: Buffer, cfg: SarvamConfig, getStore: () => ProviderStore): Promise<GatewayResult> {
  const body = json(raw);
  if (typeof body.attempt_id === "string") {
    const e = parseSarvamOutbound(body);
    if (e.appId !== cfg.appId || e.agentDigits !== cfg.agentDigits) reject("wrong_provider_account", 403);
    const store = getStore();
    const identity = await store.findSarvamAttempt(e.appId, e.attemptId);
    if (!identity) reject("unknown_attempt", 403);
    await store.ingest({
      source: "sarvam", id: `${e.appId}:outbound:${e.attemptId}:${e.status}`, type: "sarvam.outbound", status: e.status, ...identity!,
      payload: { app_id: e.appId, app_version: e.appVersion, attempt_id: e.attemptId, status: e.status, duration_seconds: e.durationSeconds, interaction_id: e.interactionId },
    });
    return accepted();
  }
  const e = parseSarvamInbound(body);
  if (!cfg.deploymentId) reject("provider_account_not_configured", 503);
  if (e.deploymentId !== cfg.deploymentId || e.appId !== cfg.appId || e.agentDigits !== cfg.agentDigits) reject("wrong_provider_account", 403);
  const store = getStore();
  const identity = await store.resolveContact("sarvam", e.appId, e.callerDigits);
  if (!identity) reject("unregistered_sender", 403);
  await store.ingest({
    source: "sarvam", id: `${e.deploymentId}:inbound:${e.interactionId}`, type: "sarvam.inbound", status: "completed", ...identity!,
    payload: { app_id: e.appId, deployment_id: e.deploymentId, interaction_id: e.interactionId, duration_seconds: e.durationSeconds, started_at: e.startedAt, ended_at: e.endedAt },
  });
  return accepted();
}

/** TeleCMI missed-call CDR. Unsigned: configured appid + virtual number and a registered caller are required. */
export async function handleTeleCmi(raw: Buffer, cfg: TeleCmiConfig, getStore: () => ProviderStore, now = Date.now()): Promise<GatewayResult> {
  const e = parseTeleCmiMissed(json(raw), now);
  if (e.appId !== cfg.appId || e.virtualDigits !== cfg.virtualDigits) reject("wrong_provider_account", 403);
  const store = getStore();
  const identity = await store.resolveContact("telecmi", String(e.appId), e.callerDigits);
  if (!identity) reject("unregistered_sender", 403);
  await store.ingest({
    source: "telecmi", id: `${e.appId}:missed:${e.callId}`, type: "telecmi.missed_call", status: "missed", ...identity!,
    payload: { app_id: e.appId, call_id: e.callId, occurred_at: e.occurredAt },
  });
  return accepted();
}

/** Official Twilio algorithm: URL + each param name and value, names sorted; HMAC-SHA1, base64. */
export function verifyTwilioSignature(publicUrl: string, params: URLSearchParams, signature: string | null, authToken: string): boolean {
  if (!authToken || !signature || !publicUrl.startsWith("https://")) return false;
  let data = publicUrl;
  for (const key of [...new Set(params.keys())].sort()) for (const v of params.getAll(key).sort()) data += key + v;
  const expected = createHmac("sha1", authToken).update(data).digest();
  const actual = Buffer.from(signature, "base64");
  return /^[A-Za-z0-9+/]{27}=$/.test(signature) && actual.length === expected.length && timingSafeEqual(actual, expected);
}

function twilioParams(raw: Buffer, contentType: string | null, signature: string | null, url: string | undefined, cfg: TwilioConfig): URLSearchParams {
  if (!cfg.authToken || !cfg.accountSid) reject("not_configured", 503);
  if (!url) reject("provider_account_not_configured", 503);
  if (!contentType?.toLowerCase().startsWith("application/x-www-form-urlencoded")) reject("unsupported_media_type", 415);
  const params = new URLSearchParams(raw.toString("utf8"));
  if ([...params.keys()].length > 100) reject("payload_too_large", 413);
  if (!verifyTwilioSignature(url!, params, signature, cfg.authToken)) reject("unauthorized", 401);
  return params;
}

/** Twilio call status callback. Signature uses the configured public URL, never the request's Host header. */
export async function handleTwilioStatus(raw: Buffer, contentType: string | null, signature: string | null, cfg: TwilioConfig, getStore: () => ProviderStore): Promise<GatewayResult> {
  const e = parseTwilioStatus(twilioParams(raw, contentType, signature, cfg.statusUrl, cfg));
  if (e.accountSid !== cfg.accountSid) reject("wrong_provider_account", 403);
  const store = getStore();
  const call = await store.findTwilioCall(e.callSid);
  if (!call) reject("unknown_call", 403);
  await store.ingest({
    source: "twilio", id: `${e.accountSid}:call:${e.callSid}:${e.status}:${e.sequence}`, type: "twilio.call_status", status: e.status,
    familyId: call!.familyId, personId: call!.personId,
    payload: { account_sid: e.accountSid, call_sid: e.callSid, status: e.status, sequence: Number(e.sequence) },
  });
  return accepted();
}

/**
 * Twilio recording status callback. Persisting a 'completed' event queues retrieval for a worker; it does not
 * mean the recording was fetched, stored, delivered or heard. Unconsented calls are rejected before any write.
 */
export async function handleTwilioRecording(raw: Buffer, contentType: string | null, signature: string | null, cfg: TwilioConfig, getStore: () => ProviderStore): Promise<GatewayResult> {
  const e = parseTwilioRecording(twilioParams(raw, contentType, signature, cfg.recordingUrl, cfg));
  if (e.accountSid !== cfg.accountSid) reject("wrong_provider_account", 403);
  const store = getStore();
  const call = await store.findTwilioCall(e.callSid);
  if (!call) reject("unknown_call", 403);
  if (!call!.aiDisclosed || !call!.recordingConsent) reject("recording_consent_missing", 403);
  await store.ingest({
    source: "twilio", id: `${e.accountSid}:recording:${e.recordingSid}:${e.status}`,
    type: e.status === "completed" ? "twilio.recording.retrieval_requested" : "twilio.recording.status", status: e.status,
    familyId: call!.familyId, personId: call!.personId,
    payload: { account_sid: e.accountSid, call_sid: e.callSid, recording_sid: e.recordingSid, status: e.status, duration_seconds: Number(e.durationSeconds) },
  });
  return accepted();
}

/** Normalise configured numbers once; a malformed configured number fails closed as 503. */
export function configuredDigits(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return phoneDigits(value); } catch { return undefined; }
}
