import { createClient } from "@supabase/supabase-js";
import type { DatabaseProbeResult, ReadinessDependencies } from "./types";

/**
 * Checks if database credentials are present in the environment.
 */
export function isRealDatabaseConfigured(): boolean {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(url && url.trim().length > 0 && key && key.trim().length > 0);
}

/**
 * Probes the connected Supabase instance with a bounded timeout and abort signal.
 * Checks that the database is reachable and that the foundational schema exists.
 * Does not expose credentials, tenant identifiers, or raw SQL errors.
 */
export async function probeRealDatabase(timeoutMs: number): Promise<DatabaseProbeResult> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return {
      ok: false,
      status: "not_configured",
      code: "database_not_configured"
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const startTime = Date.now();

  try {
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Probe the foundation schema: public.families table must exist and be accessible.
    const { error } = await supabase
      .from("families")
      .select("id")
      .limit(1)
      .abortSignal(controller.signal);

    const latencyMs = Date.now() - startTime;

    if (error) {
      // Check for missing table/schema indicators (PostgreSQL 42P01: undefined_table)
      const isSchemaMissing =
        error.code === "42P01" ||
        error.message?.includes("does not exist") ||
        error.message?.includes("relation") ||
        error.details?.includes("does not exist");

      if (isSchemaMissing) {
        return {
          ok: false,
          status: "missing_schema",
          code: "schema_missing",
          latencyMs
        };
      }

      return {
        ok: false,
        status: "unhealthy",
        code: "database_error",
        latencyMs
      };
    }

    return {
      ok: true,
      status: "connected",
      latencyMs,
      schemaOk: true
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime;
    const isAbort =
      controller.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort")));

    if (isAbort) {
      return {
        ok: false,
        status: "timeout",
        code: "database_timeout",
        latencyMs
      };
    }

    return {
      ok: false,
      status: "unreachable",
      code: "database_unreachable",
      latencyMs
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Production dependency ports for readiness checking.
 */
export const defaultReadinessDependencies: ReadinessDependencies = {
  isConfigured: isRealDatabaseConfigured,
  probeDatabase: probeRealDatabase
};
