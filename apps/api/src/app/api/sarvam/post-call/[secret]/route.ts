import { NextResponse } from "next/server";
import { safeTokenEquals } from "@/lib/secrets";

export const runtime = "nodejs";
export async function POST(_request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const expected = process.env.SARVAM_HOOK_SECRET;
  const { secret } = await params;
  if (!expected || !safeTokenEquals(secret, expected)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Do NOT acknowledge calls before attempted-ID verification and DB persistence exist.
  return NextResponse.json({ error: "provider_verification_and_storage_not_ready" }, { status: 503 });
}
