import { createCore2Service } from "./service";
import { createInMemoryCore2Repository } from "./repository";
import { createCore2Timeline } from "./timeline-adapter";
import { createCore2Gate } from "./gate-adapter";
import { createCore2EventStore } from "./event-store-adapter";
import { createCore2Outbox } from "./outbox-adapter";
import type { Core2ServicePorts } from "./contracts";

export const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-type": "application/json",
};

export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;
  const match = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/.exec(authHeader);
  return match ? match[1] : null;
}

let defaultServiceInstance: ReturnType<typeof createCore2Service> | null = null;

export function getDefaultCore2Service(overridePorts?: Partial<Core2ServicePorts>) {
  if (overridePorts) {
    const fullPorts: Core2ServicePorts = {
      auth: overridePorts.auth ?? {
        verifyBearer: async (t) => (t ? { userId: "synthetic-auth-user" } : null),
      },
      repo: overridePorts.repo ?? createInMemoryCore2Repository(),
      timeline: overridePorts.timeline ?? createCore2Timeline(),
      gate: overridePorts.gate ?? createCore2Gate(),
      eventStore: overridePorts.eventStore ?? createCore2EventStore(),
      outbox: overridePorts.outbox ?? createCore2Outbox(),
      now: overridePorts.now,
    };
    defaultServiceInstance = createCore2Service(fullPorts);
    return defaultServiceInstance;
  }

  if (!defaultServiceInstance) {
    defaultServiceInstance = createCore2Service({
      auth: {
        verifyBearer: async (t) => (t ? { userId: "synthetic-auth-user" } : null),
      },
      repo: createInMemoryCore2Repository(),
      timeline: createCore2Timeline(),
      gate: createCore2Gate(),
      eventStore: createCore2EventStore(),
      outbox: createCore2Outbox(),
    });
  }

  return defaultServiceInstance;
}
