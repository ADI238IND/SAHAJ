import { NextResponse } from "next/server";
import { getDefaultCore2Service, SECURITY_HEADERS, Core2ServiceError } from "@/lib/core2";
import { safeTokenEquals } from "@/lib/secrets";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const cronHeader = request.headers.get("x-cron-secret");

  // In production or when CRON_SECRET is configured, require secure header match
  if (secret && !safeTokenEquals(cronHeader, secret)) {
    return NextResponse.json({ error: "unauthorized_cron" }, { status: 401, headers: SECURITY_HEADERS });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const service = getDefaultCore2Service();
  try {
    const result = await service.handleProcessOverdueWatches(body);
    return NextResponse.json(result.body, { status: result.status, headers: SECURITY_HEADERS });
  } catch (error) {
    if (error instanceof Core2ServiceError) {
      return NextResponse.json(
        { error: error.code, details: error.details },
        { status: error.status, headers: SECURITY_HEADERS }
      );
    }
    return NextResponse.json({ error: "internal_error" }, { status: 500, headers: SECURITY_HEADERS });
  }
}
