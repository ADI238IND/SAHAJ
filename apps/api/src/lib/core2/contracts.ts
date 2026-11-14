import type { GateDecision } from "@sahaj/gate";
import type { StoredInput } from "../event-store";
import type { SignedTimelineEvent } from "../timeline";

// ---------------------------------------------------------------------------
// Strict, Bounded Validation Helpers (Pure TS, zero extra manifest dependencies)
// ---------------------------------------------------------------------------

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (val: unknown): val is string => typeof val === "string" && UUID_REGEX.test(val);
export const isInteger = (val: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): val is number =>
  typeof val === "number" && Number.isSafeInteger(val) && val >= min && val <= max;
export const isString = (val: unknown, min = 1, max = 256): val is string =>
  typeof val === "string" && val.length >= min && val.length <= max;
export const isOptionalString = (val: unknown, min = 1, max = 256): val is string | undefined =>
  val === undefined || isString(val, min, max);

export type ValidationResult<T> = { success: true; data: T } | { success: false; error: { issues: string[] } };

function fail<T>(...errors: string[]): ValidationResult<T> {
  return { success: false, error: { issues: errors } };
}

// ---------------------------------------------------------------------------
// Inbound Core 2 Request Interfaces and Validators
// ---------------------------------------------------------------------------

export interface SosTriggerRequest {
  familyId: string;
  personId: string;
  idempotencyKey: string;
  triggerType: "sos_button" | "late_watch_timeout" | "panic_phrase";
  locationHint?: string;
  note?: string;
}

export function parseSosTriggerRequest(input: unknown): ValidationResult<SosTriggerRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_body");
  const r = input as Record<string, unknown>;
  const allowedKeys = new Set(["familyId", "personId", "idempotencyKey", "triggerType", "locationHint", "note"]);
  for (const k of Object.keys(r)) {
    if (!allowedKeys.has(k)) return fail(`unknown_property_${k}`);
  }
  if (!isUuid(r.familyId)) return fail("invalid_familyId");
  if (!isUuid(r.personId)) return fail("invalid_personId");
  if (!isString(r.idempotencyKey, 1, 256)) return fail("invalid_idempotencyKey");
  const triggerType = r.triggerType ?? "sos_button";
  if (triggerType !== "sos_button" && triggerType !== "late_watch_timeout" && triggerType !== "panic_phrase") {
    return fail("invalid_triggerType");
  }
  if (!isOptionalString(r.locationHint, 1, 128)) return fail("invalid_locationHint");
  if (!isOptionalString(r.note, 1, 256)) return fail("invalid_note");

  return {
    success: true,
    data: {
      familyId: r.familyId,
      personId: r.personId,
      idempotencyKey: r.idempotencyKey,
      triggerType: triggerType as any,
      locationHint: r.locationHint as string | undefined,
      note: r.note as string | undefined,
    },
  };
}

export interface IAmSafeRequest {
  familyId: string;
  personId: string;
  idempotencyKey: string;
  reassuranceNote: string;
  audioClipRef?: string;
}

export function parseIAmSafeRequest(input: unknown): ValidationResult<IAmSafeRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_body");
  const r = input as Record<string, unknown>;
  const allowedKeys = new Set(["familyId", "personId", "idempotencyKey", "reassuranceNote", "audioClipRef"]);
  for (const k of Object.keys(r)) {
    if (!allowedKeys.has(k)) return fail(`unknown_property_${k}`);
  }
  if (!isUuid(r.familyId)) return fail("invalid_familyId");
  if (!isUuid(r.personId)) return fail("invalid_personId");
  if (!isString(r.idempotencyKey, 1, 256)) return fail("invalid_idempotencyKey");
  const reassuranceNote = r.reassuranceNote !== undefined ? r.reassuranceNote : "Main safe hoon";
  if (!isString(reassuranceNote, 1, 256)) return fail("invalid_reassuranceNote");
  if (!isOptionalString(r.audioClipRef, 1, 256)) return fail("invalid_audioClipRef");

  return {
    success: true,
    data: {
      familyId: r.familyId,
      personId: r.personId,
      idempotencyKey: r.idempotencyKey,
      reassuranceNote,
      audioClipRef: r.audioClipRef as string | undefined,
    },
  };
}

export interface LateWatchCreateRequest {
  familyId: string;
  personId: string;
  idempotencyKey: string;
  destinationLabel: string;
  originLabel?: string;
  transportNote?: string;
  minutesUntilExpected: number;
  gracePeriodMinutes: number;
}

export function parseLateWatchCreateRequest(input: unknown): ValidationResult<LateWatchCreateRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_body");
  const r = input as Record<string, unknown>;
  const allowedKeys = new Set(["familyId", "personId", "idempotencyKey", "destinationLabel", "originLabel", "transportNote", "minutesUntilExpected", "gracePeriodMinutes"]);
  for (const k of Object.keys(r)) {
    if (!allowedKeys.has(k)) return fail(`unknown_property_${k}`);
  }
  if (!isUuid(r.familyId)) return fail("invalid_familyId");
  if (!isUuid(r.personId)) return fail("invalid_personId");
  if (!isString(r.idempotencyKey, 1, 256)) return fail("invalid_idempotencyKey");
  if (!isString(r.destinationLabel, 1, 128)) return fail("invalid_destinationLabel");
  if (!isOptionalString(r.originLabel, 1, 128)) return fail("invalid_originLabel");
  if (!isOptionalString(r.transportNote, 1, 128)) return fail("invalid_transportNote");
  if (!isInteger(r.minutesUntilExpected, 5, 720)) return fail("invalid_minutesUntilExpected");
  const gracePeriodMinutes = r.gracePeriodMinutes !== undefined ? r.gracePeriodMinutes : 5;
  if (!isInteger(gracePeriodMinutes, 0, 120)) return fail("invalid_gracePeriodMinutes");

  return {
    success: true,
    data: {
      familyId: r.familyId,
      personId: r.personId,
      idempotencyKey: r.idempotencyKey,
      destinationLabel: r.destinationLabel,
      originLabel: r.originLabel as string | undefined,
      transportNote: r.transportNote as string | undefined,
      minutesUntilExpected: r.minutesUntilExpected,
      gracePeriodMinutes,
    },
  };
}

export interface TrustedContactCreateRequest {
  familyId: string;
  childPersonId: string;
  contactPersonId: string;
  relationship: string;
  priorityOrder: number;
  capabilities: string[];
}

export function parseTrustedContactCreateRequest(input: unknown): ValidationResult<TrustedContactCreateRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_body");
  const r = input as Record<string, unknown>;
  const allowedKeys = new Set(["familyId", "childPersonId", "contactPersonId", "relationship", "priorityOrder", "capabilities"]);
  for (const k of Object.keys(r)) {
    if (!allowedKeys.has(k)) return fail(`unknown_property_${k}`);
  }
  if (!isUuid(r.familyId)) return fail("invalid_familyId");
  if (!isUuid(r.childPersonId)) return fail("invalid_childPersonId");
  if (!isUuid(r.contactPersonId)) return fail("invalid_contactPersonId");
  if (!isString(r.relationship, 1, 64)) return fail("invalid_relationship");
  if (!isInteger(r.priorityOrder, 1, 20)) return fail("invalid_priorityOrder");
  const caps = r.capabilities ?? ["emergency_alert", "voice_reassurance"];
  if (!Array.isArray(caps) || caps.length === 0 || caps.length > 10 || !caps.every((c) => isString(c, 1, 64))) {
    return fail("invalid_capabilities");
  }

  return {
    success: true,
    data: {
      familyId: r.familyId,
      childPersonId: r.childPersonId,
      contactPersonId: r.contactPersonId,
      relationship: r.relationship,
      priorityOrder: r.priorityOrder,
      capabilities: caps as string[],
    },
  };
}

export interface TrustedContactRevokeRequest {
  familyId: string;
  contactId: string;
  reason?: string;
}

export function parseTrustedContactRevokeRequest(input: unknown): ValidationResult<TrustedContactRevokeRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_body");
  const r = input as Record<string, unknown>;
  const allowedKeys = new Set(["familyId", "contactId", "reason"]);
  for (const k of Object.keys(r)) {
    if (!allowedKeys.has(k)) return fail(`unknown_property_${k}`);
  }
  if (!isUuid(r.familyId)) return fail("invalid_familyId");
  if (!isUuid(r.contactId)) return fail("invalid_contactId");
  if (!isOptionalString(r.reason, 1, 128)) return fail("invalid_reason");

  return {
    success: true,
    data: {
      familyId: r.familyId,
      contactId: r.contactId,
      reason: r.reason as string | undefined,
    },
  };
}

export interface ResponderAcceptanceRequest {
  familyId: string;
  incidentId: string;
  responderPersonId: string;
  providerEventId: string;
  accountId: string;
}

export function parseResponderAcceptanceRequest(input: unknown): ValidationResult<ResponderAcceptanceRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_body");
  const r = input as Record<string, unknown>;
  const allowedKeys = new Set(["familyId", "incidentId", "responderPersonId", "providerEventId", "accountId"]);
  for (const k of Object.keys(r)) {
    if (!allowedKeys.has(k)) return fail(`unknown_property_${k}`);
  }
  if (!isUuid(r.familyId)) return fail("invalid_familyId");
  if (!isUuid(r.incidentId)) return fail("invalid_incidentId");
  if (!isUuid(r.responderPersonId)) return fail("invalid_responderPersonId");
  if (!isUuid(r.providerEventId)) return fail("invalid_providerEventId");
  if (!isString(r.accountId, 1, 128)) return fail("invalid_accountId");

  return {
    success: true,
    data: {
      familyId: r.familyId,
      incidentId: r.incidentId,
      responderPersonId: r.responderPersonId,
      providerEventId: r.providerEventId,
      accountId: r.accountId,
    },
  };
}

export interface TruthLineQueryRequest {
  familyId: string;
  queriedByPersonId: string;
  targetPersonId: string;
  queryType: "safety_status" | "whereabouts_reassurance" | "incident_status";
}

export function parseTruthLineQueryRequest(input: unknown): ValidationResult<TruthLineQueryRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_body");
  const r = input as Record<string, unknown>;
  const allowedKeys = new Set(["familyId", "queriedByPersonId", "targetPersonId", "queryType"]);
  for (const k of Object.keys(r)) {
    if (!allowedKeys.has(k)) return fail(`unknown_property_${k}`);
  }
  if (!isUuid(r.familyId)) return fail("invalid_familyId");
  if (!isUuid(r.queriedByPersonId)) return fail("invalid_queriedByPersonId");
  if (!isUuid(r.targetPersonId)) return fail("invalid_targetPersonId");
  const queryType = r.queryType ?? "safety_status";
  if (queryType !== "safety_status" && queryType !== "whereabouts_reassurance" && queryType !== "incident_status") {
    return fail("invalid_queryType");
  }

  return {
    success: true,
    data: {
      familyId: r.familyId,
      queriedByPersonId: r.queriedByPersonId,
      targetPersonId: r.targetPersonId,
      queryType: queryType as any,
    },
  };
}

export interface Core2CronOverdueRequest {
  workerId: string;
  leaseSeconds: number;
  limit: number;
}

export function parseCore2CronOverdueRequest(input: unknown): ValidationResult<Core2CronOverdueRequest> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_body");
  const r = input as Record<string, unknown>;
  const allowedKeys = new Set(["workerId", "leaseSeconds", "limit"]);
  for (const k of Object.keys(r)) {
    if (!allowedKeys.has(k)) return fail(`unknown_property_${k}`);
  }
  const workerId = r.workerId !== undefined ? r.workerId : "worker-core2-cron";
  if (!isString(workerId, 1, 128)) return fail("invalid_workerId");
  const leaseSeconds = r.leaseSeconds !== undefined ? r.leaseSeconds : 60;
  if (!isInteger(leaseSeconds, 10, 600)) return fail("invalid_leaseSeconds");
  const limit = r.limit !== undefined ? r.limit : 20;
  if (!isInteger(limit, 1, 100)) return fail("invalid_limit");

  return {
    success: true,
    data: {
      workerId,
      leaseSeconds,
      limit,
    },
  };
}

// ---------------------------------------------------------------------------
// Domain Models and State Types
// ---------------------------------------------------------------------------

export type WatchStatus = "active" | "safe" | "escalated" | "cancelled";
export type IncidentSeverity = "routine" | "urgent" | "critical";
export type IncidentState = "open" | "offered" | "accepted" | "heard" | "done" | "reopened" | "escalated" | "closed";
export type AssignmentStatus = "offered" | "accepted" | "declined" | "expired" | "completed";
export type ContactStatus = "pending" | "verified" | "active" | "revoked";

export interface MembershipRecord {
  familyId: string;
  userId: string;
  personId: string;
  role: "parent" | "child" | "circle";
  revokedAt: string | null;
}

export interface PersonRecord {
  id: string;
  familyId: string;
  displayName: string;
  role: "parent" | "child" | "circle";
}

export interface LateWatchRecord {
  id: string;
  familyId: string;
  personId: string;
  destinationLabel: string;
  originLabel?: string | null;
  transportNote?: string | null;
  expectedBy: string;
  gracePeriodSeconds: number;
  escalateAfter: string;
  status: WatchStatus;
  safeAt?: string | null;
  cancelledAt?: string | null;
  escalatedAt?: string | null;
  incidentId?: string | null;
  leaseToken?: string | null;
  leaseUntil?: string | null;
  workerId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SosTriggerRecord {
  id: string;
  familyId: string;
  personId: string;
  incidentId: string;
  rawEventId?: string | null;
  idempotencyKey: string;
  payloadHash: string;
  triggerType: "sos_button" | "late_watch_timeout" | "panic_phrase";
  status: "triggered" | "escalating" | "acknowledged" | "resolved" | "cancelled";
  cancellationReason?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface TrustedContactRecord {
  id: string;
  familyId: string;
  childPersonId: string;
  contactPersonId: string;
  priorityOrder: number;
  relationship: string;
  capabilities: string[];
  status: ContactStatus;
  verifiedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
}

export interface IncidentRecord {
  id: string;
  familyId: string;
  personId: string;
  ownerPersonId?: string | null;
  severity: IncidentSeverity;
  state: IncidentState;
  createdAt: string;
}

export interface AssignmentRecord {
  id: string;
  familyId: string;
  incidentId: string;
  personId: string;
  status: AssignmentStatus;
  offeredAt: string;
  expiresAt: string;
  acceptedAt?: string | null;
  verifiedByProviderEvent?: string | null;
}

export interface TruthLineRecord {
  id: string;
  familyId: string;
  queriedByPersonId: string;
  targetPersonId: string;
  queryType: string;
  statusReported: "safe" | "monitoring" | "urgent_action_underway" | "unknown";
  reassurancePhraseHi: string;
  reassurancePhraseEn: string;
  createdAt: string;
}

export interface CommandIdempotencyRecord {
  familyId: string;
  scope: string;
  idempotencyKey: string;
  payloadHash: string;
  responseStatus: number;
  responseBody: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Typed Port Interfaces for Injected Services
// ---------------------------------------------------------------------------

export interface Core2AuthPort {
  verifyBearer(token: string): Promise<{ userId: string } | null>;
}

export interface Core2TimelinePort {
  signEvent(entry: {
    familyId: string;
    eventId: string;
    sequence?: number;
    dedupeKey: string;
    eventType: string;
    entityId: string | null;
    humanLine: string;
    occurredAt?: string;
    keyId?: string;
    payload: unknown;
  }): Promise<SignedTimelineEvent>;
}

export interface Core2GatePort {
  check(input: {
    actorId: string;
    familyId: string;
    action: string;
    targetId: string;
    now?: string;
  }): Promise<GateDecision>;
}

export interface Core2EventStorePort {
  persistEncryptedRawEvent(event: StoredInput): Promise<void>;
}

export interface Core2OutboxAction {
  familyId: string;
  kind: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

export interface Core2OutboxPort {
  claimAndDispatch(action: Core2OutboxAction): Promise<{ queued: boolean; dedupeKey: string }>;
}

export interface Core2RepositoryPort {
  getMembership(userId: string, familyId: string): Promise<MembershipRecord | null>;
  getPerson(familyId: string, personId: string): Promise<PersonRecord | null>;
  getIdempotency(familyId: string, scope: string, idempotencyKey: string): Promise<CommandIdempotencyRecord | null>;
  saveIdempotency(record: CommandIdempotencyRecord): Promise<void>;
  
  createSosTrigger(params: {
    familyId: string;
    personId: string;
    idempotencyKey: string;
    payloadHash: string;
    triggerType: string;
    severity: IncidentSeverity;
    locationHint?: string;
  }): Promise<{ trigger: SosTriggerRecord; incident: IncidentRecord }>;

  getSosTriggerByIdempotency(familyId: string, idempotencyKey: string): Promise<SosTriggerRecord | null>;
  
  createLateWatch(params: {
    familyId: string;
    personId: string;
    destinationLabel: string;
    originLabel?: string;
    transportNote?: string;
    expectedBy: string;
    gracePeriodSeconds: number;
    escalateAfter: string;
  }): Promise<LateWatchRecord>;

  getActiveLateWatch(familyId: string, personId: string): Promise<LateWatchRecord | null>;
  getLateWatchById(familyId: string, watchId: string): Promise<LateWatchRecord | null>;
  markSafeMonotonic(familyId: string, personId: string, note?: string): Promise<{
    watchesUpdated: number;
    incidentsResolved: number;
    currentStatus: "safe";
  }>;

  claimOverdueWatches(workerId: string, leaseSeconds: number, limit: number): Promise<LateWatchRecord[]>;
  escalateWatchToIncident(familyId: string, watchId: string): Promise<{ watch: LateWatchRecord; incident: IncidentRecord }>;

  listActiveTrustedContacts(familyId: string, childPersonId: string): Promise<TrustedContactRecord[]>;
  addTrustedContact(params: {
    familyId: string;
    childPersonId: string;
    contactPersonId: string;
    priorityOrder: number;
    relationship: string;
    capabilities: string[];
  }): Promise<TrustedContactRecord>;
  revokeTrustedContact(familyId: string, contactId: string): Promise<TrustedContactRecord>;

  createAssignment(params: {
    familyId: string;
    incidentId: string;
    personId: string;
    expiresAt: string;
  }): Promise<AssignmentRecord>;

  verifyResponderAcceptance(params: {
    familyId: string;
    incidentId: string;
    responderPersonId: string;
    providerEventId: string;
  }): Promise<boolean>;

  recordTruthLineQuery(params: {
    familyId: string;
    queriedByPersonId: string;
    targetPersonId: string;
    queryType: string;
    statusReported: "safe" | "monitoring" | "urgent_action_underway" | "unknown";
    phraseHi: string;
    phraseEn: string;
  }): Promise<TruthLineRecord>;
}

export interface Core2ServicePorts {
  auth: Core2AuthPort;
  repo: Core2RepositoryPort;
  timeline: Core2TimelinePort;
  gate: Core2GatePort;
  eventStore: Core2EventStorePort;
  outbox: Core2OutboxPort;
  now?: () => Date;
}
