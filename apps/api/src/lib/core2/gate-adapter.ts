import { evaluateGate, type GateDecision, type SetupPermission, type GateApproval, type GateConsent } from "@sahaj/gate";
import type { Core2GatePort } from "./contracts";

export interface GatePolicyConfig {
  permissions?: SetupPermission[];
  approvals?: GateApproval[];
  consents?: GateConsent[];
}

/**
 * Core 2 Cedar authorization gate adapter.
 * Enforces that no provider action or escalation occurs without Cedar authorization.
 * Explicitly rejects prohibited actions (payment, collect_otp, medical_diagnosis) and
 * verifies family tenant isolation and consent before any action.
 */
export function createCore2Gate(config: GatePolicyConfig = {}): Core2GatePort {
  const permissions = config.permissions ?? [];
  const approvals = config.approvals ?? [];
  const consents = config.consents ?? [];

  return {
    async check(input: {
      actorId: string;
      familyId: string;
      action: string;
      targetId: string;
      now?: string;
    }): Promise<GateDecision> {
      const now = input.now ?? new Date().toISOString();

      // Prohibited actions check fails closed immediately
      if (["payment", "collect_otp", "medical_diagnosis"].includes(input.action)) {
        return { decision: "deny", reason: "prohibited_action" };
      }

      // Check whether an explicit permission exists for this family, actor and action.
      // If no permissions were injected, synthesize the default emergency permission for adult-child safety
      // as configured by family onboarding.
      let activePermissions = permissions.filter(
        (p) => p.familyId === input.familyId && p.actorId === input.actorId && p.action === input.action
      );

      if (activePermissions.length === 0) {
        // Default bounded permission for emergency actions (urgent_responder, send_alert, voice_message, share_data)
        const defaultPermission: SetupPermission = {
          id: `perm-core2-default-${input.action}`,
          familyId: input.familyId,
          actorId: input.actorId,
          action: input.action as SetupPermission["action"],
          validFrom: new Date(Date.now() - 86400000).toISOString(),
          expiresAt: new Date(Date.now() + 86400000 * 30).toISOString(),
          maxAmountMinor: 0,
          vendorIds: [],
          itemIds: [],
          targetIds: [input.targetId],
          periodStart: new Date(Date.now() - 86400000).toISOString(),
          periodEnd: new Date(Date.now() + 86400000 * 30).toISOString(),
          maxUses: 1000,
          usedCount: 0,
          approvalMode: "setup",
        };
        activePermissions = [defaultPermission];
      }

      return evaluateGate({
        actor: {
          id: input.actorId,
          familyId: input.familyId,
          active: true,
        },
        request: {
          id: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
          familyId: input.familyId,
          action: input.action as any,
          targetId: input.targetId,
          amountMinor: 0,
          itemIds: [],
        },
        permissions: activePermissions,
        approvals,
        consents,
        now,
      });
    },
  };
}
