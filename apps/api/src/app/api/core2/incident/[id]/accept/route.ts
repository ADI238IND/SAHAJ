import { NextResponse } from "next/server";
import { getDefaultCore2Service, extractBearerToken, SECURITY_HEADERS, Core2ServiceError } from "@/lib/core2";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> }
) {
  const token = extractBearerToken(request);
  const { id } = await route.params;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: SECURITY_HEADERS });
  }

  const service = getDefaultCore2Service();
  try {
    const result = await service.handleVerifyResponderAcceptance(token, {
      ...body,
      incidentId: id,
    });
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
