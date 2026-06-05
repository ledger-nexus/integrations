// POST /api/internal/dsr/attribution
//
// Internal endpoint for ledger-core's buildUserDataExport() to fetch
// integrations' DSR attribution slice (Privacy TSC). Wraps the
// already-shipped connectionsAttribution helper.
//
// Gated by INTERNAL_API_TOKEN (shared portfolio secret — same value
// ledger-core uses in its own env). Fails closed (503) if unset.
//
// Wire format:
//   POST /api/internal/dsr/attribution
//   Authorization: Bearer $INTERNAL_API_TOKEN
//   Content-Type: application/json
//   { "userId": "<uuid>" }
//
// Success (200): ConnectionsAttribution shape from connections-export.ts
//   {
//     connectionsCreated: number,
//     connectionsByStatus: Record<ConnectionStatus, number>,
//     syncRunsInitiated: number,
//     connectionsBySystem: Record<string, number>,
//     snapshotAt: string
//   }
//
// Failure:
//   503 { ok: false, error: { code: "UNAUTHORIZED", message } } — token unset
//   401 { ok: false, error: { code: "UNAUTHORIZED", message } } — wrong token
//   400 { ok: false, error: { code: "BAD_REQUEST", message } } — bad body
//   500 { ok: false, error: { code: "INTERNAL_ERROR", message } } — helper threw
//
// HARD INVARIANT: the response NEVER includes Connection.credentialsJson
// in any form (Art. 15(4) rights-of-others carve-out). The
// connectionsAttribution helper's TypeScript interface forbids
// credentials-shaped fields; this endpoint just forwards the helper's
// return value verbatim.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { connectionsAttribution } from "@/lib/privacy/connections-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

type ErrorCode = "UNAUTHORIZED" | "BAD_REQUEST" | "INTERNAL_ERROR";

function err(code: ErrorCode, message: string, status: number) {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status }
  );
}

interface JsonBody {
  userId: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) {
    return err(
      "UNAUTHORIZED",
      "INTERNAL_API_TOKEN env var is not set — endpoint disabled. Set it in the deployment env to enable.",
      503
    );
  }

  // Constant-time bearer-token check (pen-test pass 4 convention).
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  if (!constantTimeEquals(authHeader, expected)) {
    return err("UNAUTHORIZED", "Invalid or missing bearer token", 401);
  }

  let body: JsonBody;
  try {
    body = (await req.json()) as JsonBody;
  } catch {
    return err("BAD_REQUEST", "Body must be valid JSON", 400);
  }

  if (
    !body.userId ||
    typeof body.userId !== "string" ||
    body.userId.length === 0
  ) {
    return err(
      "BAD_REQUEST",
      "Required: userId (non-empty string, typically a uuid)",
      400
    );
  }

  try {
    const attribution = await connectionsAttribution(prisma, body.userId);
    return NextResponse.json(attribution);
  } catch (e) {
    return err(
      "INTERNAL_ERROR",
      e instanceof Error ? e.message : "Unknown error assembling attribution",
      500
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "METHOD_NOT_ALLOWED",
        message:
          "POST only. Include `Authorization: Bearer $INTERNAL_API_TOKEN` and a JSON body of `{ userId }`.",
      },
    },
    { status: 405 }
  );
}
