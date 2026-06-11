// Smoke tests for POST /api/internal/dsr/attribution.
//
// Exercise the auth/validation envelope around the existing
// connectionsAttribution helper. Integration-level checks (real DB
// counts) are already covered in connections-export-integration.test.ts;
// this suite tests only the HTTP wrapper.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const TOKEN = "test-internal-api-token-min-32-chars-long";

// Mock the prisma singleton + the attribution helper so the suite
// doesn't need a live DB. Real DB behavior is tested elsewhere.
vi.mock("@/lib/db", () => ({
  prisma: {},
}));
const helperFn = vi.fn();
vi.mock("@/lib/privacy/connections-export", () => ({
  connectionsAttribution: (...args: unknown[]) => helperFn(...args),
}));

function buildRequest(opts: {
  token?: string;
  body?: unknown;
  raw?: string;
}): NextRequest {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return new NextRequest("http://localhost/api/internal/dsr/attribution", {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(opts.body ?? {}),
  });
}

describe("POST /api/internal/dsr/attribution (integrations)", () => {
  beforeEach(() => {
    helperFn.mockReset();
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_TOKEN;
  });

  it("503 when INTERNAL_API_TOKEN is unset (fail-closed)", async () => {
    const { POST } = await import("../src/app/api/internal/dsr/attribution/route");
    const res = await POST(buildRequest({ token: "anything", body: { userId: "u1" } }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(json.error.message).toContain("INTERNAL_API_TOKEN");
    // Helper never called when auth fails.
    expect(helperFn).not.toHaveBeenCalled();
  });

  it("401 when bearer token is wrong", async () => {
    process.env.INTERNAL_API_TOKEN = TOKEN;
    const { POST } = await import("../src/app/api/internal/dsr/attribution/route");
    const res = await POST(buildRequest({ token: "wrong-token", body: { userId: "u1" } }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(helperFn).not.toHaveBeenCalled();
  });

  it("401 when authorization header is missing", async () => {
    process.env.INTERNAL_API_TOKEN = TOKEN;
    const { POST } = await import("../src/app/api/internal/dsr/attribution/route");
    const res = await POST(buildRequest({ body: { userId: "u1" } }));
    expect(res.status).toBe(401);
    expect(helperFn).not.toHaveBeenCalled();
  });

  it("400 when body is not valid JSON", async () => {
    process.env.INTERNAL_API_TOKEN = TOKEN;
    const { POST } = await import("../src/app/api/internal/dsr/attribution/route");
    const res = await POST(buildRequest({ token: TOKEN, raw: "{ not json" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("BAD_REQUEST");
    expect(helperFn).not.toHaveBeenCalled();
  });

  it("400 when userId is missing", async () => {
    process.env.INTERNAL_API_TOKEN = TOKEN;
    const { POST } = await import("../src/app/api/internal/dsr/attribution/route");
    const res = await POST(buildRequest({ token: TOKEN, body: {} }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("userId");
    expect(helperFn).not.toHaveBeenCalled();
  });

  it("200 with the helper's return value when auth + body are valid", async () => {
    process.env.INTERNAL_API_TOKEN = TOKEN;
    const attribution = {
      connectionsCreated: 3,
      connectionsByStatus: { ACTIVE: 2, PAUSED: 1, REVOKED: 0, ERROR: 0 },
      syncRunsInitiated: 10,
      connectionsBySystem: { plaid: 2, stripe: 1 },
      snapshotAt: "2026-06-04T12:00:00.000Z",
    };
    helperFn.mockResolvedValueOnce(attribution);

    const { POST } = await import("../src/app/api/internal/dsr/attribution/route");
    const res = await POST(buildRequest({ token: TOKEN, body: { userId: "user-uuid-1" } }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(attribution);
    expect(helperFn).toHaveBeenCalledWith(expect.any(Object), "user-uuid-1");
  });

  it("500 with helper error message when the helper throws", async () => {
    process.env.INTERNAL_API_TOKEN = TOKEN;
    helperFn.mockRejectedValueOnce(new Error("DB connection lost"));

    const { POST } = await import("../src/app/api/internal/dsr/attribution/route");
    const res = await POST(buildRequest({ token: TOKEN, body: { userId: "user-uuid-1" } }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(json.error.message).toContain("DB connection lost");
  });
});
