import { NextResponse } from "next/server";

export const runtime = "nodejs";
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "sahaj-core1-api",
    stage: "milestone-1-scaffold",
    database: "not-yet-connected",
    voice: "not-yet-connected",
    emergency_ready: false
  }, { headers: { "Cache-Control": "no-store" } });
}
