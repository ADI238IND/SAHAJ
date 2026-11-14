import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { signTimelineEvent, type SignedTimelineEvent } from "../timeline";
import type { Core2TimelinePort } from "./contracts";

export interface TimelineKeyConfig {
  keyId?: string;
  privateKey?: KeyObject | string;
}

/**
 * Core 2 signed timeline adapter.
 * Uses Ed25519 signing to bind every adult-child safety milestone (SOS, Late-Watch,
 * Reassurance, Responder Acceptance) into a tamper-evident cryptographic hash chain.
 */
export function createCore2Timeline(config: TimelineKeyConfig = {}): Core2TimelinePort {
  let privateKey = config.privateKey;
  const keyId = config.keyId ?? "core2-ed25519-v1";

  if (!privateKey) {
    const pair = generateKeyPairSync("ed25519");
    privateKey = pair.privateKey;
  }

  const streamHeads = new Map<string, { sequence: number; lastHash: string | null }>();

  return {
    async signEvent(entry: {
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
    }): Promise<SignedTimelineEvent> {
      const head = streamHeads.get(entry.familyId) ?? { sequence: 0, lastHash: null };
      const nextSequence = entry.sequence ?? head.sequence + 1;
      const occurredAt = entry.occurredAt ?? new Date().toISOString();

      const signed = signTimelineEvent(
        {
          familyId: entry.familyId,
          eventId: entry.eventId,
          sequence: nextSequence,
          dedupeKey: entry.dedupeKey,
          eventType: entry.eventType,
          entityId: entry.entityId,
          humanLine: entry.humanLine,
          previousHash: head.lastHash,
          occurredAt,
          keyId: entry.keyId ?? keyId,
          payload: entry.payload,
        },
        privateKey!
      );

      streamHeads.set(entry.familyId, {
        sequence: nextSequence,
        lastHash: signed.chainHash,
      });

      return signed;
    },
  };
}
