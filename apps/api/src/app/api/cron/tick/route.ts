import { NextResponse } from "next/server";
import { safeTokenEquals } from "@/lib/secrets";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (!safeTokenEquals(request.headers.get("x-cron-secret"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ accepted: true, jobs_run: 0, stage: "scaffold-only" }, { status: 202 });
}
