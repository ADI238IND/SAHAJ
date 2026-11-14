import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { safeTokenEquals } from "@/lib/secrets";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && challenge !== null && safeTokenEquals(token, process.env.WHATSAPP_VERIFY_TOKEN)) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

export async function POST(request: Request) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const body = await request.text();
  const received = request.headers.get("x-hub-signature-256");
  const expected = createHmac("sha256", secret).update(body).digest();
  const validFormat = received !== null && /^sha256=[0-9a-f]{64}$/.test(received);
  const actual = validFormat ? Buffer.from(received.slice(7), "hex") : Buffer.alloc(32);
  if (!validFormat || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Intentionally no logging, no successful acknowledgment before idempotent persistence.
  return NextResponse.json({ error: "event_storage_not_ready" }, { status: 503 });
}
