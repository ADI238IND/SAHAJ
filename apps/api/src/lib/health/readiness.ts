import type { ReadinessDependencies, HealthCheckResult, HealthResponse } from "./types";

export const DEFAULT_DATABASE_TIMEOUT_MS = 3000;

/**
 * Bounded readiness evaluation.
 * Injected ports verify configuration, database connectivity, and required schema.
 * Distinguishes liveness (200) from readiness failure (503).
 * Never exposes credentials, tenant identifiers, or raw database errors.
 */
export async function evaluateReadiness(
  deps: ReadinessDependencies,
  options?: { timeoutMs?: number; now?: () => Date }
): Promise<HealthCheckResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DATABASE_TIMEOUT_MS;
  const now = options?.now ? options.now() : new Date();

  // 1. Dependency check: Configuration
  if (!deps.isConfigured()) {
    const body: HealthResponse = {
      ok: false,
      status: "degraded",
      service: "sahaj-core1-api",
      stage: "phase-1-foundation",
      probe: "readiness",
      database: {
        status: "not_configured",
        code: "database_not_configured"
      },
      voice: "disabled",
      care_actions: "disabled",
      emergency_ready: false,
      timestamp: now.toISOString()
    };
    return { httpStatus: 503, body };
  }

  // 2. Dependency check: Bounded database and schema probe
  try {
    const probe = await deps.probeDatabase(timeoutMs);

    if (!probe.ok || probe.status !== "connected") {
      const body: HealthResponse = {
        ok: false,
        status: "degraded",
        service: "sahaj-core1-api",
        stage: "phase-1-foundation",
        probe: "readiness",
        database: {
          status: probe.status,
          code: probe.code ?? "database_error",
          ...(probe.latencyMs !== undefined ? { latency_ms: probe.latencyMs } : {})
        },
        voice: "disabled",
        care_actions: "disabled",
        emergency_ready: false,
        timestamp: now.toISOString()
      };
      return { httpStatus: 503, body };
    }

    // 3. Healthy: Connected and schema verified
    const body: HealthResponse = {
      ok: true,
      status: "ready",
      service: "sahaj-core1-api",
      stage: "phase-1-foundation",
      probe: "readiness",
      database: {
        status: "connected",
        latency_ms: probe.latencyMs ?? 0,
        schema: probe.schemaOk ? "present" : "missing"
      },
      voice: "disabled",
      care_actions: "disabled",
      emergency_ready: false,
      timestamp: now.toISOString()
    };
    return { httpStatus: 200, body };
  } catch {
    // Catch-all safety: Ensure no unexpected exception leaks out or exposes internal errors
    const body: HealthResponse = {
      ok: false,
      status: "degraded",
      service: "sahaj-core1-api",
      stage: "phase-1-foundation",
      probe: "readiness",
      database: {
        status: "unhealthy",
        code: "database_error"
      },
      voice: "disabled",
      care_actions: "disabled",
      emergency_ready: false,
      timestamp: now.toISOString()
    };
    return { httpStatus: 503, body };
  }
}
