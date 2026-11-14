import type { WatchStatus } from "./contracts";

export interface ReassuranceInput {
  targetName: string;
  relationship: string;
  watchStatus?: WatchStatus | null;
  expectedBy?: string | null;
  destination?: string | null;
  hasActiveSos?: boolean;
  responderAcceptedName?: string | null;
  consentRevoked?: boolean;
}

export interface ReassuranceOutput {
  status: "safe" | "monitoring" | "urgent_action_underway" | "unknown";
  phraseHi: string;
  phraseEn: string;
  redacted: boolean;
}

/** Redacts vehicle numbers, 10-digit mobile numbers, and 4+ digit numbers */
export function redactSensitiveDetails(text: string): string {
  return text
    .replace(/([A-Z]{2}\s*\d{2}\s*[A-Z]{1,2}\s*\d{1,4})/gi, "<VEHICLE_NUM>")
    .replace(/\b\d{10}\b/g, "<MOBILE_10>")
    .replace(/\b\d{4,}\b/g, "<NUM>");
}

/** Formats a reassurance line for Maa's truth-line, respecting privacy and consent */
export function generateReassurance(input: ReassuranceInput): ReassuranceOutput {
  const {
    targetName,
    watchStatus,
    hasActiveSos,
    responderAcceptedName,
    consentRevoked,
  } = input;

  // 1. Consent revoked: minimal high-level operational response only
  if (consentRevoked) {
    return {
      status: "monitoring",
      phraseHi: `${targetName} safe hain. Kripya parivar ke designated sadasya se sampark karein.`,
      phraseEn: `${targetName} is safe. Please connect with the designated family contact for details.`,
      redacted: true,
    };
  }

  // 2. Active SOS or escalated incident underway
  if (hasActiveSos || watchStatus === "escalated") {
    if (responderAcceptedName) {
      return {
        status: "urgent_action_underway",
        phraseHi: `${targetName} ki urgent call pe ${responderAcceptedName} pahunch rahe hain. Sahaj team follow up kar rahi hai.`,
        phraseEn: `${responderAcceptedName} has accepted and is on the way for ${targetName}. Sahaj is following up.`,
        redacted: false,
      };
    }
    return {
      status: "urgent_action_underway",
      phraseHi: `${targetName} ke safety alerts circle ko bheje gaye hain. Sahaj trusted contacts se sampark kar raha hai.`,
      phraseEn: `Safety alerts have been dispatched to ${targetName}'s circle. Sahaj is coordinating with trusted contacts.`,
      redacted: false,
    };
  }

  // 3. Late Watch active (on schedule)
  if (watchStatus === "active") {
    const dest = input.destination ? redactSensitiveDetails(input.destination) : "ghar";
    return {
      status: "monitoring",
      phraseHi: `${targetName} raaste mein hain aur ${dest} aa rahi hain. Sab theek chal raha hai.`,
      phraseEn: `${targetName} is on the way to ${dest}. Travel is being monitored and on schedule.`,
      redacted: Boolean(input.destination && input.destination.length > 0),
    };
  }

  // 4. Marked Safe ("Main safe hoon")
  if (watchStatus === "safe" || (!watchStatus && !hasActiveSos)) {
    return {
      status: "safe",
      phraseHi: `${targetName} bilkul theek hain. Unhone 'Main safe hoon' confirm kar diya hai.`,
      phraseEn: `${targetName} is safe and doing well. 'I am safe' confirmed.`,
      redacted: false,
    };
  }

  // 5. Default/Unknown state
  return {
    status: "unknown",
    phraseHi: `${targetName} ki safety status verify ho rahi hai. Parivar ko alert kiya gaya hai.`,
    phraseEn: `Verifying safety status for ${targetName}. Family is kept updated.`,
    redacted: false,
  };
}
