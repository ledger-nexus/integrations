// Tenant-aware session helpers for integrations' Server Actions.
// Mirror of recon/revenue-rec's session.ts — see those for full rationale.

import { prisma } from "@/lib/db";

export interface CurrentUser { id: string; email: string; displayName: string; }
/** Note: role typing stays string here — integrations didn't get the
 * TenantRole enum mirror that landed in recon/revenue-rec/fa-amort.
 * That's a separate cleanup item; the column value is the same string
 * one of the enum members would produce, just untyped. */
export interface CurrentTenant {
  id: string;
  slug: string;
  name: string;
  role: string;
  /** Stripe plan key. Null when no subscription. */
  billingPlan: string | null;
  /** Stripe subscription status. Null when none. */
  subscriptionStatus: string | null;
}

export class NotAuthenticatedError extends Error {
  constructor() { super("Not authenticated"); this.name = "NotAuthenticatedError"; }
}
export class NoTenantSelectedError extends Error {
  constructor() {
    super("No active tenant — zero or multiple tenant memberships");
    this.name = "NoTenantSelectedError";
  }
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const email = await resolveClerkEmail();
  if (!email) return null;
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, displayName: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  return { id: user.id, email: user.email, displayName: user.displayName };
}

export async function requireCurrentUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new NotAuthenticatedError();
  return u;
}

export async function getCurrentTenant(): Promise<CurrentTenant | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const ms = await prisma.tenantMembership.findMany({
    where: { userId: user.id },
    include: {
      tenant: {
        select: {
          id: true,
          slug: true,
          name: true,
          billingPlan: true,
          subscriptionStatus: true,
        },
      },
    },
  });
  if (ms.length !== 1) return null;
  return {
    id: ms[0].tenant.id,
    slug: ms[0].tenant.slug,
    name: ms[0].tenant.name,
    role: ms[0].role,
    billingPlan: ms[0].tenant.billingPlan,
    subscriptionStatus: ms[0].tenant.subscriptionStatus,
  };
}

export async function requireCurrentTenant(): Promise<CurrentTenant> {
  await requireCurrentUser();
  const t = await getCurrentTenant();
  if (!t) throw new NoTenantSelectedError();
  return t;
}

async function resolveClerkEmail(): Promise<string | null> {
  if (!process.env.CLERK_SECRET_KEY) return null;
  try {
    const { auth, clerkClient } = await import("@clerk/nextjs/server");
    const { userId } = await auth();
    if (!userId) return null;
    const client = await clerkClient();
    const u = await client.users.getUser(userId);
    return u.primaryEmailAddress?.emailAddress ?? null;
  } catch {
    return null;
  }
}
