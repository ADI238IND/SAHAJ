import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { isRealDatabaseConfigured, probeRealDatabase } from "../../src/lib/health/ports";

// Mock @supabase/supabase-js
vi.mock("@supabase/supabase-js", () => {
  return {
    createClient: vi.fn()
  };
});

import { createClient } from "@supabase/supabase-js";

describe("probeRealDatabase port logic", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reports not_configured when environment variables are missing", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(isRealDatabaseConfigured()).toBe(false);
    const result = await probeRealDatabase(500);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("not_configured");
    expect(result.code).toBe("database_not_configured");
  });

  it("reports connected and schemaOk when query succeeds", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    expect(isRealDatabaseConfigured()).toBe(true);

    const mockSelect = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockResolvedValue({ data: [{ id: "fam-1" }], error: null })
      })
    });

    vi.mocked(createClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: mockSelect
      })
    } as unknown as ReturnType<typeof createClient>);

    const result = await probeRealDatabase(500);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("connected");
    expect(result.schemaOk).toBe(true);
    expect(result.latencyMs).toBeTypeOf("number");
  });

  it("reports missing_schema when query returns relation does not exist (42P01)", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    const mockSelect = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "42P01", message: "relation \"families\" does not exist" }
        })
      })
    });

    vi.mocked(createClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: mockSelect
      })
    } as unknown as ReturnType<typeof createClient>);

    const result = await probeRealDatabase(500);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("missing_schema");
    expect(result.code).toBe("schema_missing");
  });

  it("reports unreachable when query fails with network error", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    const mockSelect = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED"))
      })
    });

    vi.mocked(createClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: mockSelect
      })
    } as unknown as ReturnType<typeof createClient>);

    const result = await probeRealDatabase(500);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("unreachable");
    expect(result.code).toBe("database_unreachable");
  });

  it("reports timeout when query aborts due to deadline exceed", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    const mockSelect = vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockRejectedValue(abortError)
      })
    });

    vi.mocked(createClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: mockSelect
      })
    } as unknown as ReturnType<typeof createClient>);

    const result = await probeRealDatabase(50);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.code).toBe("database_timeout");
  });
});
