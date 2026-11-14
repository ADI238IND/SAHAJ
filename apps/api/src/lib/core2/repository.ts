import { randomUUID } from "node:crypto";
import type {
  Core2RepositoryPort,
  MembershipRecord,
  PersonRecord,
  CommandIdempotencyRecord,
  LateWatchRecord,
  SosTriggerRecord,
  IncidentRecord,
  TrustedContactRecord,
  AssignmentRecord,
  TruthLineRecord,
  IncidentSeverity,
} from "./contracts";

export class RepositoryError extends Error {
  constructor(public readonly code: string, public readonly status = 500) {
    super(code);
    this.name = "RepositoryError";
  }
}

export interface InMemoryDbState {
  memberships?: MembershipRecord[];
  people?: PersonRecord[];
  idempotencies?: CommandIdempotencyRecord[];
  watches?: LateWatchRecord[];
  sosTriggers?: SosTriggerRecord[];
  incidents?: IncidentRecord[];
  trustedContacts?: TrustedContactRecord[];
  assignments?: AssignmentRecord[];
  truthLineQueries?: TruthLineRecord[];
  rawEvents?: Array<{ id: string; familyId: string; source: string; providerEventId: string }>;
}

/**
 * Creates an in-memory repository implementing Core2RepositoryPort.
 * Enforces strict family isolation, monotonic watch states, and scoped command idempotency.
 */
export function createInMemoryCore2Repository(initialState: InMemoryDbState = {}): Core2RepositoryPort {
  const memberships = [...(initialState.memberships ?? [])];
  const people = [...(initialState.people ?? [])];
  const idempotencies = new Map<string, CommandIdempotencyRecord>();
  for (const item of initialState.idempotencies ?? []) {
    idempotencies.set(`${item.familyId}:${item.scope}:${item.idempotencyKey}`, item);
  }

  const watches = new Map<string, LateWatchRecord>();
  for (const item of initialState.watches ?? []) {
    watches.set(item.id, { ...item });
  }

  const sosTriggers = new Map<string, SosTriggerRecord>();
  for (const item of initialState.sosTriggers ?? []) {
    sosTriggers.set(item.id, { ...item });
  }

  const incidents = new Map<string, IncidentRecord>();
  for (const item of initialState.incidents ?? []) {
    incidents.set(item.id, { ...item });
  }

  const trustedContacts = new Map<string, TrustedContactRecord>();
  for (const item of initialState.trustedContacts ?? []) {
    trustedContacts.set(item.id, { ...item });
  }

  const assignments = new Map<string, AssignmentRecord>();
  for (const item of initialState.assignments ?? []) {
    assignments.set(item.id, { ...item });
  }

  const truthLineQueries: TruthLineRecord[] = [...(initialState.truthLineQueries ?? [])];
  const rawEvents = new Map<string, { id: string; familyId: string; source: string; providerEventId: string }>();
  for (const item of initialState.rawEvents ?? []) {
    rawEvents.set(item.id, item);
  }

  return {
    async getMembership(userId: string, familyId: string): Promise<MembershipRecord | null> {
      const found = memberships.find(
        (m) => m.userId === userId && m.familyId === familyId && !m.revokedAt
      );
      return found ? { ...found } : null;
    },

    async getPerson(familyId: string, personId: string): Promise<PersonRecord | null> {
      const found = people.find((p) => p.familyId === familyId && p.id === personId);
      return found ? { ...found } : null;
    },

    async getIdempotency(familyId: string, scope: string, idempotencyKey: string): Promise<CommandIdempotencyRecord | null> {
      const record = idempotencies.get(`${familyId}:${scope}:${idempotencyKey}`);
      return record ? { ...record } : null;
    },

    async saveIdempotency(record: CommandIdempotencyRecord): Promise<void> {
      idempotencies.set(`${record.familyId}:${record.scope}:${record.idempotencyKey}`, { ...record });
    },

    async createSosTrigger(params: {
      familyId: string;
      personId: string;
      idempotencyKey: string;
      payloadHash: string;
      triggerType: string;
      severity: IncidentSeverity;
      locationHint?: string;
    }): Promise<{ trigger: SosTriggerRecord; incident: IncidentRecord }> {
      const incidentId = randomUUID();
      const triggerId = randomUUID();
      const now = new Date().toISOString();

      const incident: IncidentRecord = {
        id: incidentId,
        familyId: params.familyId,
        personId: params.personId,
        severity: params.severity,
        state: "open",
        createdAt: now,
      };
      incidents.set(incidentId, incident);

      const trigger: SosTriggerRecord = {
        id: triggerId,
        familyId: params.familyId,
        personId: params.personId,
        incidentId,
        idempotencyKey: params.idempotencyKey,
        payloadHash: params.payloadHash,
        triggerType: params.triggerType as any,
        status: "triggered",
        createdAt: now,
      };
      sosTriggers.set(triggerId, trigger);

      return { trigger: { ...trigger }, incident: { ...incident } };
    },

    async getSosTriggerByIdempotency(familyId: string, idempotencyKey: string): Promise<SosTriggerRecord | null> {
      for (const t of sosTriggers.values()) {
        if (t.familyId === familyId && t.idempotencyKey === idempotencyKey) {
          return { ...t };
        }
      }
      return null;
    },

    async createLateWatch(params: {
      familyId: string;
      personId: string;
      destinationLabel: string;
      originLabel?: string;
      transportNote?: string;
      expectedBy: string;
      gracePeriodSeconds: number;
      escalateAfter: string;
    }): Promise<LateWatchRecord> {
      const id = randomUUID();
      const now = new Date().toISOString();

      const watch: LateWatchRecord = {
        id,
        familyId: params.familyId,
        personId: params.personId,
        destinationLabel: params.destinationLabel,
        originLabel: params.originLabel ?? null,
        transportNote: params.transportNote ?? null,
        expectedBy: params.expectedBy,
        gracePeriodSeconds: params.gracePeriodSeconds,
        escalateAfter: params.escalateAfter,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };

      watches.set(id, watch);
      return { ...watch };
    },

    async getActiveLateWatch(familyId: string, personId: string): Promise<LateWatchRecord | null> {
      for (const w of watches.values()) {
        if (w.familyId === familyId && w.personId === personId && w.status === "active") {
          return { ...w };
        }
      }
      return null;
    },

    async getLateWatchById(familyId: string, watchId: string): Promise<LateWatchRecord | null> {
      const found = watches.get(watchId);
      if (found && found.familyId === familyId) {
        return found;
      }
      return null;
    },

    async markSafeMonotonic(
      familyId: string,
      personId: string,
      note = "Main safe hoon"
    ): Promise<{
      watchesUpdated: number;
      incidentsResolved: number;
      currentStatus: "safe";
    }> {
      const now = new Date().toISOString();
      let watchesUpdated = 0;
      let incidentsResolved = 0;

      // 1. Monotonically transition any active or escalated watch to 'safe'
      for (const [id, w] of watches.entries()) {
        if (w.familyId === familyId && w.personId === personId && (w.status === "active" || w.status === "escalated")) {
          watches.set(id, {
            ...w,
            status: "safe",
            safeAt: now,
            updatedAt: now,
          });
          watchesUpdated++;

          if (w.incidentId) {
            const inc = incidents.get(w.incidentId);
            if (inc && inc.familyId === familyId && inc.state !== "done" && inc.state !== "closed") {
              incidents.set(inc.id, {
                ...inc,
                state: "done",
              });
              incidentsResolved++;
            }
          }
        }
      }

      // 2. Mark any open SOS triggers and incidents as resolved
      for (const [id, t] of sosTriggers.entries()) {
        if (t.familyId === familyId && t.personId === personId && t.status !== "resolved" && t.status !== "cancelled") {
          sosTriggers.set(id, {
            ...t,
            status: "resolved",
            resolvedAt: now,
            cancellationReason: note,
          });

          const inc = incidents.get(t.incidentId);
          if (inc && inc.familyId === familyId && inc.state !== "done" && inc.state !== "closed") {
            incidents.set(inc.id, {
              ...inc,
              state: "done",
            });
            incidentsResolved++;
          }
        }
      }

      return {
        watchesUpdated,
        incidentsResolved,
        currentStatus: "safe",
      };
    },

    async claimOverdueWatches(workerId: string, leaseSeconds: number, limit: number): Promise<LateWatchRecord[]> {
      const now = new Date();
      const claimed: LateWatchRecord[] = [];

      for (const [id, w] of watches.entries()) {
        if (claimed.length >= limit) break;
        if (w.status !== "active") continue;
        if (new Date(w.escalateAfter) > now) continue;

        // Check lease
        if (w.leaseUntil && new Date(w.leaseUntil) > now) continue;

        const leaseToken = randomUUID();
        const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
        const updated: LateWatchRecord = {
          ...w,
          leaseToken,
          leaseUntil,
          workerId,
          updatedAt: now.toISOString(),
        };

        watches.set(id, updated);
        claimed.push({ ...updated });
      }

      return claimed;
    },

    async escalateWatchToIncident(
      familyId: string,
      watchId: string
    ): Promise<{ watch: LateWatchRecord; incident: IncidentRecord }> {
      const watch = watches.get(watchId);
      if (!watch || watch.familyId !== familyId) {
        throw new RepositoryError("watch_not_found", 404);
      }

      // Monotonic check: if watch was already marked safe or cancelled, it CANNOT be escalated
      if (watch.status === "safe" || watch.status === "cancelled") {
        throw new RepositoryError("monotonic_watch_transition_violation", 409);
      }

      const now = new Date().toISOString();
      const incidentId = randomUUID();
      const incident: IncidentRecord = {
        id: incidentId,
        familyId,
        personId: watch.personId,
        severity: "urgent",
        state: "open",
        createdAt: now,
      };
      incidents.set(incidentId, incident);

      const updatedWatch: LateWatchRecord = {
        ...watch,
        status: "escalated",
        escalatedAt: now,
        incidentId,
        updatedAt: now,
      };
      watches.set(watchId, updatedWatch);

      return { watch: { ...updatedWatch }, incident: { ...incident } };
    },

    async listActiveTrustedContacts(familyId: string, childPersonId: string): Promise<TrustedContactRecord[]> {
      const results: TrustedContactRecord[] = [];
      for (const c of trustedContacts.values()) {
        if (
          c.familyId === familyId &&
          c.childPersonId === childPersonId &&
          c.status !== "revoked" &&
          !c.revokedAt
        ) {
          results.push({ ...c });
        }
      }
      return results.sort((a, b) => a.priorityOrder - b.priorityOrder);
    },

    async addTrustedContact(params: {
      familyId: string;
      childPersonId: string;
      contactPersonId: string;
      priorityOrder: number;
      relationship: string;
      capabilities: string[];
    }): Promise<TrustedContactRecord> {
      // Check existing in same family
      for (const c of trustedContacts.values()) {
        if (
          c.familyId === params.familyId &&
          c.childPersonId === params.childPersonId &&
          c.contactPersonId === params.contactPersonId
        ) {
          throw new RepositoryError("contact_already_exists", 409);
        }
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const record: TrustedContactRecord = {
        id,
        familyId: params.familyId,
        childPersonId: params.childPersonId,
        contactPersonId: params.contactPersonId,
        priorityOrder: params.priorityOrder,
        relationship: params.relationship,
        capabilities: params.capabilities,
        status: "active",
        verifiedAt: now,
        revokedAt: null,
        createdAt: now,
      };

      trustedContacts.set(id, record);
      return { ...record };
    },

    async revokeTrustedContact(familyId: string, contactId: string): Promise<TrustedContactRecord> {
      const contact = trustedContacts.get(contactId);
      if (!contact || contact.familyId !== familyId) {
        throw new RepositoryError("contact_not_found", 404);
      }

      const now = new Date().toISOString();
      const updated: TrustedContactRecord = {
        ...contact,
        status: "revoked",
        revokedAt: now,
      };
      trustedContacts.set(contactId, updated);
      return { ...updated };
    },

    async createAssignment(params: {
      familyId: string;
      incidentId: string;
      personId: string;
      expiresAt: string;
    }): Promise<AssignmentRecord> {
      const id = randomUUID();
      const now = new Date().toISOString();
      const record: AssignmentRecord = {
        id,
        familyId: params.familyId,
        incidentId: params.incidentId,
        personId: params.personId,
        status: "offered",
        offeredAt: now,
        expiresAt: params.expiresAt,
        acceptedAt: null,
        verifiedByProviderEvent: null,
      };

      assignments.set(id, record);
      return { ...record };
    },

    async verifyResponderAcceptance(params: {
      familyId: string;
      incidentId: string;
      responderPersonId: string;
      providerEventId: string;
    }): Promise<boolean> {
      // 1. Verify raw event exists in same family
      const raw = rawEvents.get(params.providerEventId);
      if (!raw || raw.familyId !== params.familyId) {
        return false;
      }

      // 2. Find offered assignment
      let targetAssignment: AssignmentRecord | null = null;
      for (const a of assignments.values()) {
        if (
          a.familyId === params.familyId &&
          a.incidentId === params.incidentId &&
          a.personId === params.responderPersonId &&
          a.status === "offered" &&
          new Date(a.expiresAt) > new Date()
        ) {
          targetAssignment = a;
          break;
        }
      }

      if (!targetAssignment) {
        return false;
      }

      // 3. Mark assignment accepted
      const now = new Date().toISOString();
      assignments.set(targetAssignment.id, {
        ...targetAssignment,
        status: "accepted",
        acceptedAt: now,
        verifiedByProviderEvent: params.providerEventId,
      });

      // 4. Update incident
      const inc = incidents.get(params.incidentId);
      if (inc && inc.familyId === params.familyId) {
        incidents.set(inc.id, {
          ...inc,
          state: "accepted",
          ownerPersonId: params.responderPersonId,
        });
      }

      return true;
    },

    async recordTruthLineQuery(params: {
      familyId: string;
      queriedByPersonId: string;
      targetPersonId: string;
      queryType: string;
      statusReported: "safe" | "monitoring" | "urgent_action_underway" | "unknown";
      phraseHi: string;
      phraseEn: string;
    }): Promise<TruthLineRecord> {
      const id = randomUUID();
      const now = new Date().toISOString();
      const record: TruthLineRecord = {
        id,
        familyId: params.familyId,
        queriedByPersonId: params.queriedByPersonId,
        targetPersonId: params.targetPersonId,
        queryType: params.queryType,
        statusReported: params.statusReported,
        reassurancePhraseHi: params.phraseHi,
        reassurancePhraseEn: params.phraseEn,
        createdAt: now,
      };

      truthLineQueries.push(record);
      return { ...record };
    },
  };
}
