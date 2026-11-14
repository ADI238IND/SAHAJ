import { consentIsCurrent } from "./consent";
import {
  MAX_SIGNED_URL_SECONDS, RECORDING_CONSENT_PURPOSE, voiceShareConsentPurpose,
  type DenyCode, type MediaBucket, type MediaDeps, type MediaOptions, type MediaResult, type Membership,
} from "./contracts";
import { isUuid, objectFitsBucket, validateObjectPath } from "./paths";

const deny = (code: DenyCode): MediaResult => ({
  ok: false, code,
  status: ({ unauthenticated: 401, not_found: 404, forbidden: 403, consent_required: 403, expired: 410, invalid_object: 422, unavailable: 503 } as const)[code],
});

class Stop extends Error { constructor(readonly result: MediaResult) { super(result.ok ? "ok" : result.code); } }
const stop = (code: DenyCode): never => { throw new Stop(deny(code)); };

/**
 * Read-only media access service. Clients supply only a bearer token and an opaque row id; bucket and
 * object path always come from server-side rows and are re-validated before signing.
 */
export function createMediaService(deps: MediaDeps, options: MediaOptions = {}) {
  const ttl = options.signedUrlSeconds ?? MAX_SIGNED_URL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_SIGNED_URL_SECONDS) throw new Error("invalid_signed_url_lifetime");

  async function authenticate(token: unknown): Promise<string> {
    if (typeof token !== "string" || token.length === 0 || token.length > 4096) return stop("unauthenticated");
    const user = await deps.auth.verifyBearer(token);
    if (!user || !isUuid(user.userId)) return stop("unauthenticated");
    return user.userId;
  }

  /** Live, unrevoked parent/child membership. Circle members never receive recordings here. */
  async function member(userId: string, familyId: string): Promise<Membership> {
    const m = await deps.repo.getMembership(userId, familyId);
    if (!m || m.revokedAt !== null || m.familyId !== familyId || m.userId !== userId) return stop("not_found");
    if (m.role !== "parent" && m.role !== "child") return stop("forbidden");
    return m;
  }

  async function sign(bucket: MediaBucket, familyId: string, rawPath: unknown, expiresAt: string): Promise<MediaResult> {
    const path = validateObjectPath(rawPath, familyId);
    if (!path) return stop("invalid_object");
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) return stop("invalid_object");
    if (expiry <= deps.now().getTime()) return stop("expired");
    const info = await deps.storage.stat(bucket, path);
    if (!info) return stop("not_found");
    if (!objectFitsBucket(bucket, info)) return stop("invalid_object");
    const url = await deps.storage.createSignedUrl(bucket, path, ttl);
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return stop("unavailable");
    return { ok: true, url, expiresInSeconds: ttl };
  }

  async function guarded(run: () => Promise<MediaResult>): Promise<MediaResult> {
    try { return await run(); }
    catch (error) {
      if (error instanceof Stop) return error.result;
      return deny("unavailable"); // never surface or log provider/database error text
    }
  }

  return {
    /** Sender or recipient of a voice post, with current recipient-specific sender consent. */
    voicePost: (token: unknown, postId: unknown) => guarded(async () => {
      const userId = await authenticate(token);
      if (!isUuid(postId)) return stop("not_found");
      const post = await deps.repo.getVoicePost(postId);
      if (!post || post.id !== postId) return stop("not_found");
      const m = await member(userId, post.familyId);
      // Family membership alone is not enough: the caller's person must be a party to this post.
      if (m.personId !== post.senderId && m.personId !== post.recipientId) return stop("not_found");
      const purpose = voiceShareConsentPurpose(post.recipientId);
      const [linked, history] = await Promise.all([
        deps.repo.getConsent(post.familyId, post.consentId),
        deps.repo.listConsentHistory(post.familyId, post.senderId, purpose),
      ]);
      if (!consentIsCurrent({ linked, history, familyId: post.familyId, personId: post.senderId, purpose, now: deps.now(), maxAgeMs: options.consentMaxAgeMs })) {
        return stop("consent_required");
      }
      const content = await deps.repo.getVoiceContent(post.familyId, post.id);
      if (!content || content.familyId !== post.familyId || content.voicePostId !== post.id) return stop("not_found");
      return sign("sahaj-voice", post.familyId, content.objectPath, content.expiresAt);
    }),

    /** Call recording: only the recorded parent themself, with current call-scoped recording consent. */
    callRecording: (token: unknown, callId: unknown) => guarded(async () => {
      const userId = await authenticate(token);
      if (!isUuid(callId)) return stop("not_found");
      const call = await deps.repo.getCall(callId);
      if (!call || call.id !== callId) return stop("not_found");
      const m = await member(userId, call.familyId);
      // A child never gets parent-private recordings via family membership.
      if (m.role !== "parent" || m.personId !== call.personId) return stop("not_found");
      const content = await deps.repo.getCallContent(call.familyId, call.id);
      if (!content || content.familyId !== call.familyId || content.callId !== call.id || !content.recordingObjectPath) return stop("not_found");
      const [linked, history] = await Promise.all([
        deps.repo.getConsent(call.familyId, content.consentId),
        deps.repo.listConsentHistory(call.familyId, call.personId, RECORDING_CONSENT_PURPOSE),
      ]);
      if (!consentIsCurrent({ linked, history, familyId: call.familyId, personId: call.personId, purpose: RECORDING_CONSENT_PURPOSE, callId: call.id, now: deps.now(), maxAgeMs: options.consentMaxAgeMs })) {
        return stop("consent_required");
      }
      return sign("sahaj-recordings", call.familyId, content.recordingObjectPath, content.expiresAt);
    }),
  };
}
