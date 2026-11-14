import { serviceDatabase } from "../database";
import { encryptWebhook, identityHash, payloadHash, WebhookError } from "../webhook-security";
import type { ProviderEvent, ProviderStore, Identity } from "./gateway";

/** Supabase-backed store. Service role stays server-side; nothing here logs payloads or phone numbers. */
export function providerStore(): ProviderStore {
  const { WEBHOOK_ENCRYPTION_KEY: encryptionKey, IDENTITY_HASH_SECRET: identitySecret } = process.env;
  if (!encryptionKey || !identitySecret) throw new WebhookError("event_storage_not_configured", 503);
  const db = serviceDatabase();
  const lookupFailed = () => new WebhookError("identity_lookup_failed", 503);
  const identity = (row: { family_id: unknown; person_id: unknown } | null): Identity | null =>
    row ? { familyId: String(row.family_id), personId: String(row.person_id) } : null;

  return {
    async findSarvamAttempt(appId, attemptId) {
      const { data, error } = await db.from("provider_identities").select("family_id,person_id")
        .eq("source", "sarvam").eq("account_id", appId).eq("binding_kind", "attempt")
        .eq("external_id_hash", identityHash("sarvam", appId, attemptId, identitySecret))
        .eq("attempt_id", attemptId).eq("agent_id", appId).eq("enabled", true).is("revoked_at", null).maybeSingle();
      if (error) throw lookupFailed();
      return identity(data);
    },
    async resolveContact(source, account, externalId) {
      const { data, error } = await db.from("provider_identities").select("family_id,person_id")
        .eq("source", source).eq("account_id", account).eq("binding_kind", "contact")
        .eq("external_id_hash", identityHash(source, account, externalId, identitySecret))
        .eq("enabled", true).is("revoked_at", null).maybeSingle();
      if (error) throw lookupFailed();
      return identity(data);
    },
    async findTwilioCall(callSid) {
      const { data, error } = await db.from("calls").select("family_id,person_id,ai_disclosed_at,recording_consent_at")
        .eq("provider", "twilio").eq("external_id", callSid).maybeSingle();
      if (error) throw lookupFailed();
      const who = identity(data);
      return who && data ? { ...who, aiDisclosed: !!data.ai_disclosed_at, recordingConsent: !!data.recording_consent_at } : null;
    },
    async ingest(event: ProviderEvent) {
      const body = Buffer.from(JSON.stringify(event.payload));
      const { error } = await db.rpc("ingest_raw_event", {
        p_source: event.source, p_provider_event_id: event.id, p_event_type: event.type, p_family_id: event.familyId,
        p_metadata: { person_id: event.personId, status: event.status },
        p_payload_hash: payloadHash(body),
        p_payload_ciphertext: encryptWebhook(body, encryptionKey, `${event.source}:${event.id}`),
      });
      if (error) {
        const conflict = error.code === "23505";
        throw new WebhookError(conflict ? "event_id_conflict" : "event_persistence_failed", conflict ? 409 : 503);
      }
    },
  };
}
