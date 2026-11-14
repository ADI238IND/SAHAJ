import { NextResponse } from "next/server";
import { getDefaultCore2Service, extractBearerToken, SECURITY_HEADERS, Core2ServiceError } from "@/lib/core2";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const token = extractBearerToken(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: SECURITY_HEADERS });
  }

  const service = getDefaultCore2Service();
  try {
    const result = await service.handleStartLateWatch(token, body);
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

export async function GET(request: Request) {
  const token = extractBearerToken(request);
  const url = new URL(request.url);
  const familyId = url.searchParams.get("familyId") ?? "";
  const personId = url.searchParams.get("personId") ?? "";

  const service = getDefaultCore2Service();
  try {
    const result = await service.handleGetActiveWatch(token, familyId, personId);
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
