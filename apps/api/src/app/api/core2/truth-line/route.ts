import { NextResponse } from "next/server";
import { getDefaultCore2Service, extractBearerToken, SECURITY_HEADERS, Core2ServiceError } from "@/lib/core2";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = extractBearerToken(request);
  const url = new URL(request.url);

  const queryParams = {
    familyId: url.searchParams.get("familyId"),
    queriedByPersonId: url.searchParams.get("queriedByPersonId"),
    targetPersonId: url.searchParams.get("targetPersonId"),
    queryType: url.searchParams.get("queryType"),
  };

  const service = getDefaultCore2Service();
  try {
    const result = await service.handleTruthLineQuery(token, queryParams);
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
