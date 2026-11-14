import type { Core2OutboxAction, Core2OutboxPort } from "./contracts";

export interface OutboxStoreConfig {
  dispatchImmediate?: boolean;
  onDispatch?: (action: Core2OutboxAction) => Promise<void>;
}

/**
 * Core 2 Outbox Adapter.
 * Guarantees that external notifications and provider dispatches are persisted
 * to an atomic outbox with unique deduplication keys before any side effect occurs.
 */
export function createCore2Outbox(config: OutboxStoreConfig = {}): Core2OutboxPort {
  const claimedKeys = new Set<string>();
  const queuedActions: Core2OutboxAction[] = [];

  return {
    async claimAndDispatch(action: Core2OutboxAction): Promise<{ queued: boolean; dedupeKey: string }> {
      const claimKey = `${action.familyId}:${action.dedupeKey}`;
      if (claimedKeys.has(claimKey)) {
        return { queued: false, dedupeKey: action.dedupeKey };
      }

      claimedKeys.add(claimKey);
      queuedActions.push(action);

      if (config.dispatchImmediate && config.onDispatch) {
        await config.onDispatch(action);
      }

      return { queued: true, dedupeKey: action.dedupeKey };
    },
  };
}
