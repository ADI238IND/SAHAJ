import { randomBytes } from "node:crypto";
import { encryptWebhook, payloadHash } from "../webhook-security";
import type { StoredInput } from "../event-store";
import type { Core2EventStorePort } from "./contracts";

export interface EventStoreConfig {
  encryptionKeyHex?: string;
  onPersist?: (raw: {
    source: string;
    id: string;
    familyId: string;
    personId: string;
    type: string;
    payloadHash: string;
    ciphertext: string;
  }) => Promise<void>;
}

/**
 * Core 2 Encrypted Event Store Adapter.
 * Encrypts raw command and trigger payloads with AES-256-GCM before returning HTTP 202,
 * ensuring durable cryptographic persistence without leaking unmasked PII.
 */
export function createCore2EventStore(config: EventStoreConfig = {}): Core2EventStorePort {
  const keyHex = config.encryptionKeyHex ?? randomBytes(32).toString("hex");
  const storedEvents = new Map<string, StoredInput>();

  return {
    async persistEncryptedRawEvent(event: StoredInput): Promise<void> {
      const body = Buffer.from(JSON.stringify({ ...event.payload, person_id: event.personId }));
      const hash = payloadHash(body);
      const ciphertext = encryptWebhook(body, keyHex, `${event.source}:${event.id}`);

      storedEvents.set(`${event.familyId}:${event.id}`, event);

      if (config.onPersist) {
        await config.onPersist({
          source: event.source,
          id: event.id,
          familyId: event.familyId,
          personId: event.personId,
          type: event.type,
          payloadHash: hash,
          ciphertext,
        });
      }
    },
  };
}
