import { createHash, randomUUID } from "node:crypto";
import {
  type Core2ServicePorts,
  type SosTriggerRequest,
  type IAmSafeRequest,
  type LateWatchCreateRequest,
  type TrustedContactCreateRequest,
  type TrustedContactRevokeRequest,
  type ResponderAcceptanceRequest,
  type TruthLineQueryRequest,
  type Core2CronOverdueRequest,
  parseSosTriggerRequest,
  parseIAmSafeRequest,
  parseLateWatchCreateRequest,
  parseTrustedContactCreateRequest,
  parseTrustedContactRevokeRequest,
  parseResponderAcceptanceRequest,
  parseTruthLineQueryRequest,
  parseCore2CronOverdueRequest,
} from "./contracts";
import { generateReassurance } from "./reassurance";

export class Core2ServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 400,
    public readonly details?: Record<string, unknown>
  ) {
    super(code);
    this.name = "Core2ServiceError";
  }
}

export function computePayloadHash(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

export function createCore2Service(ports: Core2ServicePorts) {
  const getNow = ports.now ?? (() => new Date());

  async function authenticateAndAuthorize(
    bearerToken: string | null,
    familyId: string,
    allowedRoles: Array<"child" | "parent" | "circle">
  ) {
    if (!bearerToken) {
      throw new Core2ServiceError("unauthorized", 401);
    }

    const verified = await ports.auth.verifyBearer(bearerToken);
    if (!verified?.userId) {
      throw new Core2ServiceError("invalid_credentials", 401);
    }

    const membership = await ports.repo.getMembership(verified.userId, familyId);
    if (!membership || membership.revokedAt !== null) {
      throw new Core2ServiceError("forbidden_not_in_family", 403);
    }

    if (!allowedRoles.includes(membership.role)) {
      throw new Core2ServiceError("insufficient_role_permissions", 403);
    }

    return { userId: verified.userId, membership };
  }

  async function checkCommandIdempotency(
    familyId: string,
    scope: string,
    idempotencyKey: string,
    payloadHash: string
  ) {
    const existing = await ports.repo.getIdempotency(familyId, scope, idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new Core2ServiceError("idempotency_payload_conflict", 409, {
          message: "Command replayed with changed parameters under same idempotency key.",
        });
      }
      return existing;
    }
    return null;
  }

  return {
    /**
     * Trigger Adult-Child SOS.
     * Persists encrypted raw event, verifies Cedar authorization, creates durable incident,
     * enqueues outbox escalation to verified trusted contacts, and signs the timeline.
     */
    async handleSosTrigger(bearerToken: string | null, rawBody: unknown) {
      if (!bearerToken) {
        throw new Core2ServiceError("unauthorized", 401);
      }

      const parsed = parseSosTriggerRequest(rawBody);
      if (!parsed.success) {
        throw new Core2ServiceError("invalid_request_schema", 422, { errors: parsed.error.issues });
      }
      const req: SosTriggerRequest = parsed.data;

      // 1. Authenticate bearer & check adult-child membership
      const { membership } = await authenticateAndAuthorize(bearerToken, req.familyId, ["child"]);
      if (membership.personId !== req.personId) {
        throw new Core2ServiceError("actor_person_mismatch", 403);
      }

      // 2. Command Idempotency check with changed-body conflict
      const pHash = computePayloadHash(req);
      const existing = await checkCommandIdempotency(req.familyId, "core2:sos", req.idempotencyKey, pHash);
      if (existing) {
        return {
          status: existing.responseStatus,
          body: existing.responseBody,
          replayed: true,
        };
      }

      // 3. Persist encrypted raw event BEFORE HTTP 202
      const rawEventId = randomUUID();
      await ports.eventStore.persistEncryptedRawEvent({
        source: "core2_app",
        id: rawEventId,
        familyId: req.familyId,
        personId: req.personId,
        type: "core2.sos.trigger",
        payload: { ...req, rawEventId },
      });

      // 4. Create durable incident (severity: critical for SOS)
      const { trigger, incident } = await ports.repo.createSosTrigger({
        familyId: req.familyId,
        personId: req.personId,
        idempotencyKey: req.idempotencyKey,
        payloadHash: pHash,
        triggerType: req.triggerType,
        severity: "critical",
        locationHint: req.locationHint,
      });

      // 5. Load active trusted contacts
      const contacts = await ports.repo.listActiveTrustedContacts(req.familyId, req.personId);

      // 6. Evaluate Cedar authorization & enqueue outbox dispatches
      const dispatchedContacts: string[] = [];
      for (const contact of contacts) {
        const gateDecision = await ports.gate.check({
          actorId: req.personId,
          familyId: req.familyId,
          action: "urgent_responder",
          targetId: contact.contactPersonId,
        });

        if (gateDecision.decision === "allow") {
          // Create assignment
          await ports.repo.createAssignment({
            familyId: req.familyId,
            incidentId: incident.id,
            personId: contact.contactPersonId,
            expiresAt: new Date(getNow().getTime() + 10 * 60 * 1000).toISOString(),
          });

          // Enqueue atomic outbox
          await ports.outbox.claimAndDispatch({
            familyId: req.familyId,
            kind: "core2.sos.alert_trusted_contact",
            dedupeKey: `sos:${incident.id}:contact:${contact.contactPersonId}`,
            payload: {
              incidentId: incident.id,
              targetPersonId: contact.contactPersonId,
              relationship: contact.relationship,
            },
          });
          dispatchedContacts.push(contact.contactPersonId);
        }
      }

      // 7. Sign timeline event
      const timelineEvent = await ports.timeline.signEvent({
        familyId: req.familyId,
        eventId: trigger.id,
        dedupeKey: `core2:sos:${trigger.id}`,
        eventType: "core2.sos.triggered",
        entityId: incident.id,
        humanLine: `SOS triggered by child. ${dispatchedContacts.length} trusted contacts alerted.`,
        occurredAt: getNow().toISOString(),
        keyId: "core2-ed25519-v1",
        payload: {
          incidentId: incident.id,
          triggerType: req.triggerType,
          dispatchedCount: dispatchedContacts.length,
        },
      });

      const responseBody = {
        status: "accepted",
        incident_id: incident.id,
        trigger_id: trigger.id,
        escalated_contacts_count: dispatchedContacts.length,
        timeline_chain_hash: timelineEvent.chainHash,
      };

      // Save idempotency record
      await ports.repo.saveIdempotency({
        familyId: req.familyId,
        scope: "core2:sos",
        idempotencyKey: req.idempotencyKey,
        payloadHash: pHash,
        responseStatus: 202,
        responseBody,
        createdAt: getNow().toISOString(),
      });

      return {
        status: 202,
        body: responseBody,
        replayed: false,
      };
    },

    /**
     * "I am safe" ("Main safe hoon") Reassurance / Cancellation.
     * Monotonically resolves active late watches and/or SOS incidents.
     * Prevents timeout race conditions: safe transition always wins over timeout.
     */
    async handleIAmSafe(bearerToken: string | null, rawBody: unknown) {
      if (!bearerToken) {
        throw new Core2ServiceError("unauthorized", 401);
      }

      const parsed = parseIAmSafeRequest(rawBody);
      if (!parsed.success) {
        throw new Core2ServiceError("invalid_request_schema", 422, { errors: parsed.error.issues });
      }
      const req: IAmSafeRequest = parsed.data;

      // 1. Authenticate bearer & membership
      const { membership } = await authenticateAndAuthorize(bearerToken, req.familyId, ["child"]);
      if (membership.personId !== req.personId) {
        throw new Core2ServiceError("actor_person_mismatch", 403);
      }

      // 2. Command idempotency check
      const pHash = computePayloadHash(req);
      const existing = await checkCommandIdempotency(req.familyId, "core2:safe", req.idempotencyKey, pHash);
      if (existing) {
        return {
          status: existing.responseStatus,
          body: existing.responseBody,
          replayed: true,
        };
      }

      // 3. Persist encrypted raw event before 202
      const rawEventId = randomUUID();
      await ports.eventStore.persistEncryptedRawEvent({
        source: "core2_app",
        id: rawEventId,
        familyId: req.familyId,
        personId: req.personId,
        type: "core2.safe.reassurance",
        payload: { ...req, rawEventId },
      });

      // 4. Monotonic state transition to safe
      const result = await ports.repo.markSafeMonotonic(req.familyId, req.personId, req.reassuranceNote);

      // 5. Evaluate Cedar authorization for reassurance notification
      const gateDecision = await ports.gate.check({
        actorId: req.personId,
        familyId: req.familyId,
        action: "send_alert",
        targetId: req.familyId,
      });

      if (gateDecision.decision === "allow") {
        await ports.outbox.claimAndDispatch({
          familyId: req.familyId,
          kind: "core2.family.reassurance_broadcast",
          dedupeKey: `safe:${req.familyId}:${req.personId}:${req.idempotencyKey}`,
          payload: {
            personId: req.personId,
            note: req.reassuranceNote,
            audioClipRef: req.audioClipRef,
          },
        });
      }

      // 6. Sign timeline event
      const timelineEvent = await ports.timeline.signEvent({
        familyId: req.familyId,
        eventId: rawEventId,
        dedupeKey: `core2:safe:${req.idempotencyKey}`,
        eventType: "core2.child.safe_confirmed",
        entityId: req.personId,
        humanLine: "Child confirmed safe: Main safe hoon.",
        occurredAt: getNow().toISOString(),
        keyId: "core2-ed25519-v1",
        payload: {
          watchesUpdated: result.watchesUpdated,
          incidentsResolved: result.incidentsResolved,
          note: req.reassuranceNote,
        },
      });

      const responseBody = {
        status: "safe",
        watches_resolved: result.watchesUpdated,
        incidents_resolved: result.incidentsResolved,
        message: "Main safe hoon reassurance recorded.",
        timeline_chain_hash: timelineEvent.chainHash,
      };

      await ports.repo.saveIdempotency({
        familyId: req.familyId,
        scope: "core2:safe",
        idempotencyKey: req.idempotencyKey,
        payloadHash: pHash,
        responseStatus: 200,
        responseBody,
        createdAt: getNow().toISOString(),
      });

      return {
        status: 200,
        body: responseBody,
        replayed: false,
      };
    },

    /**
     * Start Late-Home Watch / Scheduled Check-in.
     */
    async handleStartLateWatch(bearerToken: string | null, rawBody: unknown) {
      if (!bearerToken) {
        throw new Core2ServiceError("unauthorized", 401);
      }

      const parsed = parseLateWatchCreateRequest(rawBody);
      if (!parsed.success) {
        throw new Core2ServiceError("invalid_request_schema", 422, { errors: parsed.error.issues });
      }
      const req: LateWatchCreateRequest = parsed.data;

      // 1. Authenticate bearer & membership
      const { membership } = await authenticateAndAuthorize(bearerToken, req.familyId, ["child"]);
      if (membership.personId !== req.personId) {
        throw new Core2ServiceError("actor_person_mismatch", 403);
      }

      // 2. Command Idempotency check
      const pHash = computePayloadHash(req);
      const existing = await checkCommandIdempotency(req.familyId, "core2:watch", req.idempotencyKey, pHash);
      if (existing) {
        return {
          status: existing.responseStatus,
          body: existing.responseBody,
          replayed: true,
        };
      }

      // 3. Compute expected_by and escalate_after
      const expectedAt = new Date(getNow().getTime() + req.minutesUntilExpected * 60 * 1000);
      const graceSeconds = req.gracePeriodMinutes * 60;
      const escalateAfter = new Date(expectedAt.getTime() + graceSeconds * 1000);

      // 4. Persist encrypted raw event
      const rawEventId = randomUUID();
      await ports.eventStore.persistEncryptedRawEvent({
        source: "core2_app",
        id: rawEventId,
        familyId: req.familyId,
        personId: req.personId,
        type: "core2.watch.start",
        payload: { ...req, rawEventId, escalateAfter: escalateAfter.toISOString() },
      });

      // 5. Create durable Late Watch
      const watch = await ports.repo.createLateWatch({
        familyId: req.familyId,
        personId: req.personId,
        destinationLabel: req.destinationLabel,
        originLabel: req.originLabel,
        transportNote: req.transportNote,
        expectedBy: expectedAt.toISOString(),
        gracePeriodSeconds: graceSeconds,
        escalateAfter: escalateAfter.toISOString(),
      });

      // 6. Sign timeline event
      const timelineEvent = await ports.timeline.signEvent({
        familyId: req.familyId,
        eventId: watch.id,
        dedupeKey: `core2:watch:${watch.id}`,
        eventType: "core2.watch.started",
        entityId: watch.id,
        humanLine: `Late-home watch active for ${req.destinationLabel}. Safe check by ${expectedAt.toISOString()}.`,
        occurredAt: getNow().toISOString(),
        keyId: "core2-ed25519-v1",
        payload: {
          destination: req.destinationLabel,
          expectedBy: watch.expectedBy,
          escalateAfter: watch.escalateAfter,
        },
      });

      const responseBody = {
        status: "active",
        watch_id: watch.id,
        expected_by: watch.expectedBy,
        escalate_after: watch.escalateAfter,
        timeline_chain_hash: timelineEvent.chainHash,
      };

      await ports.repo.saveIdempotency({
        familyId: req.familyId,
        scope: "core2:watch",
        idempotencyKey: req.idempotencyKey,
        payloadHash: pHash,
        responseStatus: 201,
        responseBody,
        createdAt: getNow().toISOString(),
      });

      return {
        status: 201,
        body: responseBody,
        replayed: false,
      };
    },

    /**
     * Get Current Active Watch for person.
     */
    async handleGetActiveWatch(bearerToken: string | null, familyId: string, personId: string) {
      if (!bearerToken) {
        throw new Core2ServiceError("unauthorized", 401);
      }
      await authenticateAndAuthorize(bearerToken, familyId, ["child", "parent"]);
      const watch = await ports.repo.getActiveLateWatch(familyId, personId);
      return {
        status: 200,
        body: {
          active: Boolean(watch),
          watch: watch ?? null,
        },
      };
    },

    /**
     * Process Overdue Watches (Cron Tick Recovery).
     * Atomically claims overdue active watches, checks monotonic state,
     * escalates to incidents, alerts trusted contacts, and avoids double dispatch.
     */
    async handleProcessOverdueWatches(rawBody: unknown) {
      const parsed = parseCore2CronOverdueRequest(rawBody);
      if (!parsed.success) {
        throw new Core2ServiceError("invalid_request_schema", 422, { errors: parsed.error.issues });
      }
      const req: Core2CronOverdueRequest = parsed.data;

      // 1. Atomically claim overdue watches using lease lock
      const claimed = await ports.repo.claimOverdueWatches(req.workerId, req.leaseSeconds, req.limit);

      let escalatedCount = 0;
      for (const watch of claimed) {
        // Double check watch is still active (not marked safe by concurrent "I am safe")
        if (watch.status !== "active") {
          continue;
        }

        try {
          // Escalate to durable incident
          const { incident } = await ports.repo.escalateWatchToIncident(watch.familyId, watch.id);

          // Alert trusted contacts
          const contacts = await ports.repo.listActiveTrustedContacts(watch.familyId, watch.personId);
          for (const contact of contacts) {
            const gate = await ports.gate.check({
              actorId: watch.personId,
              familyId: watch.familyId,
              action: "urgent_responder",
              targetId: contact.contactPersonId,
            });

            if (gate.decision === "allow") {
              await ports.repo.createAssignment({
                familyId: watch.familyId,
                incidentId: incident.id,
                personId: contact.contactPersonId,
                expiresAt: new Date(getNow().getTime() + 10 * 60 * 1000).toISOString(),
              });

              await ports.outbox.claimAndDispatch({
                familyId: watch.familyId,
                kind: "core2.watch.escalated_trusted_contact",
                dedupeKey: `watch:${watch.id}:contact:${contact.contactPersonId}`,
                payload: {
                  incidentId: incident.id,
                  watchId: watch.id,
                  targetPersonId: contact.contactPersonId,
                },
              });
            }
          }

          // Sign timeline
          await ports.timeline.signEvent({
            familyId: watch.familyId,
            eventId: watch.id,
            dedupeKey: `core2:watch:overdue:${watch.id}`,
            eventType: "core2.watch.overdue_escalated",
            entityId: incident.id,
            humanLine: `Late-home watch overdue for destination ${watch.destinationLabel}. Incident opened.`,
            occurredAt: getNow().toISOString(),
            keyId: "core2-ed25519-v1",
            payload: {
              watchId: watch.id,
              incidentId: incident.id,
              contactsAlerted: contacts.length,
            },
          });

          escalatedCount++;
        } catch (err) {
          // Monotonic state violation if marked safe concurrently: ignore safely
          if (err instanceof Error && err.message.includes("monotonic")) {
            continue;
          }
          throw err;
        }
      }

      return {
        status: 200,
        body: {
          claimed_count: claimed.length,
          escalated_count: escalatedCount,
          worker_id: req.workerId,
        },
      };
    },

    /**
     * Add Trusted Contact with verification and priority ordering.
     */
    async handleAddTrustedContact(bearerToken: string | null, rawBody: unknown) {
      if (!bearerToken) {
        throw new Core2ServiceError("unauthorized", 401);
      }

      const parsed = parseTrustedContactCreateRequest(rawBody);
      if (!parsed.success) {
        throw new Core2ServiceError("invalid_request_schema", 422, { errors: parsed.error.issues });
      }
      const req: TrustedContactCreateRequest = parsed.data;

      // 1. Authenticate bearer & membership
      await authenticateAndAuthorize(bearerToken, req.familyId, ["child"]);

      // 2. Verify target person belongs to the same family
      const contactPerson = await ports.repo.getPerson(req.familyId, req.contactPersonId);
      if (!contactPerson) {
        throw new Core2ServiceError("contact_person_not_in_family", 400);
      }

      const contact = await ports.repo.addTrustedContact({
        familyId: req.familyId,
        childPersonId: req.childPersonId,
        contactPersonId: req.contactPersonId,
        priorityOrder: req.priorityOrder,
        relationship: req.relationship,
        capabilities: req.capabilities,
      });

      return {
        status: 201,
        body: {
          contact_id: contact.id,
          priority_order: contact.priorityOrder,
          status: contact.status,
        },
      };
    },

    /**
     * Revoke Trusted Contact immediately.
     */
    async handleRevokeTrustedContact(bearerToken: string | null, rawBody: unknown) {
      if (!bearerToken) {
        throw new Core2ServiceError("unauthorized", 401);
      }

      const parsed = parseTrustedContactRevokeRequest(rawBody);
      if (!parsed.success) {
        throw new Core2ServiceError("invalid_request_schema", 422, { errors: parsed.error.issues });
      }
      const req: TrustedContactRevokeRequest = parsed.data;

      // Authenticate
      await authenticateAndAuthorize(bearerToken, req.familyId, ["child"]);

      const contact = await ports.repo.revokeTrustedContact(req.familyId, req.contactId);

      // Sign timeline revocation
      await ports.timeline.signEvent({
        familyId: req.familyId,
        eventId: contact.id,
        dedupeKey: `core2:contact:revoked:${contact.id}`,
        eventType: "core2.trusted_contact.revoked",
        entityId: contact.id,
        humanLine: `Trusted contact revoked for relationship ${contact.relationship}.`,
        occurredAt: getNow().toISOString(),
        keyId: "core2-ed25519-v1",
        payload: { contactId: contact.id, relationship: contact.relationship },
      });

      return {
        status: 200,
        body: {
          contact_id: contact.id,
          status: "revoked",
          revoked_at: contact.revokedAt,
        },
      };
    },

    /**
     * List Trusted Contacts for adult child.
     */
    async handleListTrustedContacts(bearerToken: string | null, familyId: string, childPersonId: string) {
      if (!bearerToken) {
        throw new Core2ServiceError("unauthorized", 401);
      }
      await authenticateAndAuthorize(bearerToken, familyId, ["child"]);
      const contacts = await ports.repo.listActiveTrustedContacts(familyId, childPersonId);
      return {
        status: 200,
        body: {
          contacts,
        },
      };
    },

    /**
     * Verified Responder Acceptance.
     * Binds exact offered responder + incident + provider event proof.
     * Never accepts forged or wrong incident proofs.
     */
    async handleVerifyResponderAcceptance(bearerToken: string | null, rawBody: unknown) {
      if (!bearerToken) {
        throw new Core2ServiceError("unauthorized", 401);
      }

      const parsed = parseResponderAcceptanceRequest(rawBody);
      if (!parsed.success) {
        throw new Core2ServiceError("invalid_request_schema", 422, { errors: parsed.error.issues });
      }
      const req: ResponderAcceptanceRequest = parsed.data;

      // Verify caller authentication
      await authenticateAndAuthorize(bearerToken, req.familyId, ["child", "circle"]);

      // Verify responder acceptance binding
      const verified = await ports.repo.verifyResponderAcceptance({
        familyId: req.familyId,
        incidentId: req.incidentId,
        responderPersonId: req.responderPersonId,
        providerEventId: req.providerEventId,
      });

      if (!verified) {
        throw new Core2ServiceError("invalid_responder_acceptance_proof", 400, {
          message: "Could not verify offered assignment or matching raw provider event proof in family.",
        });
      }

      // Sign timeline event
      const timelineEvent = await ports.timeline.signEvent({
        familyId: req.familyId,
        eventId: req.incidentId,
        dedupeKey: `core2:acceptance:${req.incidentId}:${req.responderPersonId}`,
        eventType: "core2.incident.responder_accepted",
        entityId: req.incidentId,
        humanLine: "Responder accepted emergency assignment with verified provider proof.",
        occurredAt: getNow().toISOString(),
        keyId: "core2-ed25519-v1",
        payload: {
          incidentId: req.incidentId,
          responderPersonId: req.responderPersonId,
          providerEventId: req.providerEventId,
        },
      });

      return {
        status: 200,
        body: {
          accepted: true,
          incident_id: req.incidentId,
          responder_person_id: req.responderPersonId,
          timeline_chain_hash: timelineEvent.chainHash,
        },
      };
    },

    /**
     * Maa's Truth-Line / Family Reassurance Query.
     * Returns consent-respecting, redacted reassurance phrases in Hindi and English.
     */
    async handleTruthLineQuery(bearerToken: string | null, queryParams: Record<string, string | null>) {
      if (!bearerToken) {
        throw new Core2ServiceError("unauthorized", 401);
      }

      const parsed = parseTruthLineQueryRequest({
        familyId: queryParams.familyId,
        queriedByPersonId: queryParams.queriedByPersonId,
        targetPersonId: queryParams.targetPersonId,
        queryType: queryParams.queryType ?? "safety_status",
      });

      if (!parsed.success) {
        throw new Core2ServiceError("invalid_request_schema", 422, { errors: parsed.error.issues });
      }
      const req: TruthLineQueryRequest = parsed.data;

      // Authenticate caller (Parent or Child can query)
      await authenticateAndAuthorize(bearerToken, req.familyId, ["parent", "child"]);

      // Load target person info
      const targetPerson = await ports.repo.getPerson(req.familyId, req.targetPersonId);
      if (!targetPerson) {
        throw new Core2ServiceError("target_person_not_found", 404);
      }

      // Load active watch status (if any)
      const watch = await ports.repo.getActiveLateWatch(req.familyId, req.targetPersonId);

      // Generate reassurance
      const reassurance = generateReassurance({
        targetName: targetPerson.displayName,
        relationship: "daughter",
        watchStatus: watch ? watch.status : "safe",
        expectedBy: watch ? watch.expectedBy : null,
        destination: watch ? watch.destinationLabel : null,
      });

      // Record query
      await ports.repo.recordTruthLineQuery({
        familyId: req.familyId,
        queriedByPersonId: req.queriedByPersonId,
        targetPersonId: req.targetPersonId,
        queryType: req.queryType,
        statusReported: reassurance.status,
        phraseHi: reassurance.phraseHi,
        phraseEn: reassurance.phraseEn,
      });

      return {
        status: 200,
        body: {
          status: reassurance.status,
          phrase_hi: reassurance.phraseHi,
          phrase_en: reassurance.phraseEn,
          redacted: reassurance.redacted,
        },
      };
    },
  };
}
