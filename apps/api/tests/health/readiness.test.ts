import { describe, expect, it } from "vitest";
import { evaluateReadiness } from "../../src/lib/health/readiness";
import { evaluateLiveness } from "../../src/lib/health/liveness";
import type { DatabaseProbeResult, ReadinessDependencies } from "../../src/lib/health/types";

describe("Health & Readiness evaluation", () => {
  const fixedDate = new Date("2026-11-14T20:00:00.000Z");
  const options = { timeoutMs: 100, now: () => fixedDate };

  it("fails with 503 when database is not configured (database unavailable)", async () => {
    const deps: ReadinessDependencies = {
      isConfigured: () => false,
      probeDatabase: async () => ({
        ok: false,
        status: "not_configured",
        code: "database_not_configured"
      })
    };

    const res = await evaluateReadiness(deps, options);
    expect(res.httpStatus).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe("degraded");
    expect(res.body.probe).toBe("readiness");
    expect(res.body.database?.status).toBe("not_configured");
    expect(res.body.database?.code).toBe("database_not_configured");
    expect(res.body.emergency_ready).toBe(false);
    expect(res.body.care_actions).toBe("disabled");
    expect(res.body.voice).toBe("disabled");
    expect(res.body.timestamp).toBe(fixedDate.toISOString());
  });

  it("fails with 503 when database is configured but unreachable", async () => {
    const deps: ReadinessDependencies = {
      isConfigured: () => true,
      probeDatabase: async () => ({
        ok: false,
        status: "unreachable",
        code: "database_unreachable",
        latencyMs: 12
      })
    };

    const res = await evaluateReadiness(deps, options);
    expect(res.httpStatus).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.database?.status).toBe("unreachable");
    expect(res.body.database?.code).toBe("database_unreachable");
    expect(res.body.emergency_ready).toBe(false);
  });

  it("fails with 503 when database is reachable but schema is missing", async () => {
    const deps: ReadinessDependencies = {
      isConfigured: () => true,
      probeDatabase: async () => ({
        ok: false,
        status: "missing_schema",
        code: "schema_missing",
        latencyMs: 15
      })
    };

    const res = await evaluateReadiness(deps, options);
    expect(res.httpStatus).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.database?.status).toBe("missing_schema");
    expect(res.body.database?.code).toBe("schema_missing");
    expect(res.body.emergency_ready).toBe(false);
  });

  it("fails with 503 when bounded database probe times out", async () => {
    const deps: ReadinessDependencies = {
      isConfigured: () => true,
      probeDatabase: async () => ({
        ok: false,
        status: "timeout",
        code: "database_timeout",
        latencyMs: 105
      })
    };

    const res = await evaluateReadiness(deps, options);
    expect(res.httpStatus).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.database?.status).toBe("timeout");
    expect(res.body.database?.code).toBe("database_timeout");
  });

  it("recovers from failure dynamically when dependencies become healthy", async () => {
    let healthy = false;
    const deps: ReadinessDependencies = {
      isConfigured: () => true,
      probeDatabase: async (): Promise<DatabaseProbeResult> => {
        if (!healthy) {
          return { ok: false, status: "unreachable", code: "database_unreachable" };
        }
        return { ok: true, status: "connected", latencyMs: 5, schemaOk: true };
      }
    };

    // First call: failure
    const failRes = await evaluateReadiness(deps, options);
    expect(failRes.httpStatus).toBe(503);
    expect(failRes.body.ok).toBe(false);

    // Dependency recovers
    healthy = true;

    // Second call: recovery to 200
    const recoverRes = await evaluateReadiness(deps, options);
    expect(recoverRes.httpStatus).toBe(200);
    expect(recoverRes.body.ok).toBe(true);
    expect(recoverRes.body.status).toBe("ready");
    expect(recoverRes.body.database?.status).toBe("connected");
    expect(recoverRes.body.database?.schema).toBe("present");
    expect(recoverRes.body.emergency_ready).toBe(false);
  });

  it("guarantees safe error bodies with zero credential, tenant, or SQL leakages", async () => {
    const sensitiveTokens = [
      "postgres://postgres:SuperSecretPassword123@aws-0-ap-south-1.pooler.supabase.com:6543/postgres",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-kJ1q3P-sample-service-role-key",
      "b1000000-0000-4000-8000-000000000001",
      "relation \"families\" does not exist",
      "PG::ConnectionBad: connection to server on socket failed"
    ];

    const deps: ReadinessDependencies = {
      isConfigured: () => true,
      probeDatabase: async () => ({
        ok: false,
        status: "unhealthy",
        code: "database_error",
        latencyMs: 25
      })
    };

    const res = await evaluateReadiness(deps, options);
    const jsonStr = JSON.stringify(res.body);

    for (const secret of sensitiveTokens) {
      expect(jsonStr).not.toContain(secret);
    }

    // Only allowlisted keys exist in response
    const allowedKeys = [
      "ok",
      "status",
      "service",
      "stage",
      "probe",
      "database",
      "voice",
      "care_actions",
      "emergency_ready",
      "timestamp"
    ];
    expect(Object.keys(res.body).sort()).toEqual(allowedKeys.sort());
  });

  it("strictly enforces disabled care actions and false emergency readiness", async () => {
    // Check in both ready and degraded states
    const readyDeps: ReadinessDependencies = {
      isConfigured: () => true,
      probeDatabase: async () => ({ ok: true, status: "connected", latencyMs: 3, schemaOk: true })
    };

    const readyRes = await evaluateReadiness(readyDeps, options);
    expect(readyRes.body.emergency_ready).toBe(false);
    expect(readyRes.body.care_actions).toBe("disabled");
    expect(readyRes.body.voice).toBe("disabled");

    const downDeps: ReadinessDependencies = {
      isConfigured: () => false,
      probeDatabase: async () => ({ ok: false, status: "not_configured" })
    };

    const downRes = await evaluateReadiness(downDeps, options);
    expect(downRes.body.emergency_ready).toBe(false);
    expect(downRes.body.care_actions).toBe("disabled");
    expect(downRes.body.voice).toBe("disabled");
  });

  it("distinguishes liveness 200 from readiness 503 when dependencies are down", async () => {
    const downDeps: ReadinessDependencies = {
      isConfigured: () => false,
      probeDatabase: async () => ({ ok: false, status: "not_configured" })
    };

    const livenessRes = evaluateLiveness(options);
    const readinessRes = await evaluateReadiness(downDeps, options);

    expect(livenessRes.httpStatus).toBe(200);
    expect(livenessRes.body.ok).toBe(true);
    expect(livenessRes.body.probe).toBe("liveness");

    expect(readinessRes.httpStatus).toBe(503);
    expect(readinessRes.body.ok).toBe(false);
    expect(readinessRes.body.probe).toBe("readiness");
  });

  it("handles unexpected thrown exceptions in probe without leaking unhandled errors", async () => {
    const throwingDeps: ReadinessDependencies = {
      isConfigured: () => true,
      probeDatabase: async () => {
        throw new Error("Unhandled network error with connection string: postgresql://secret:pass@host/db");
      }
    };

    const res = await evaluateReadiness(throwingDeps, options);
    expect(res.httpStatus).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.database?.code).toBe("database_error");

    const jsonStr = JSON.stringify(res.body);
    expect(jsonStr).not.toContain("Unhandled network error");
    expect(jsonStr).not.toContain("secret:pass");
  });
});
