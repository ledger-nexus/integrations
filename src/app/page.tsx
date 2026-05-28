// Dashboard. Shows the small surface of "what's connected, what synced
// recently, what's broken." Big numbers + a recent activity stream.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatRelativeTime } from "@/lib/utils/format";
import { getCurrentTenant } from "@/lib/auth/session";
import { getRepoAccess } from "@/lib/auth/repo-access";

export default async function DashboardPage() {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope the dashboard.
  // Connection has no tenantId column; walk Connection.targetId →
  // BankAccount.entity.tenantId. SyncRun filters by connectionId in
  // that scope.
  const tenant = await getCurrentTenant();
  // Plan gate: integrations is Scale-only. Banner when not included.
  const access = tenant ? getRepoAccess(tenant) : null;
  const tenantBankAccountIds = tenant
    ? (
        await prisma.bankAccount.findMany({
          where: { entity: { tenantId: tenant.id } },
          select: { id: true },
        })
      ).map((b) => b.id)
    : [];
  const connectionWhere = tenant
    ? { targetType: "BANK_ACCOUNT" as const, targetId: { in: tenantBankAccountIds } }
    : { id: "__none__" };
  const tenantConnectionIds = tenant
    ? (
        await prisma.connection.findMany({
          where: connectionWhere,
          select: { id: true },
        })
      ).map((c) => c.id)
    : [];
  const [connections, recentRuns] = await Promise.all([
    prisma.connection.findMany({
      where: connectionWhere,
      orderBy: [{ status: "asc" }, { lastSyncedAt: "desc" }],
      take: 20,
      select: {
        id: true,
        systemCode: true,
        displayName: true,
        status: true,
        lastSyncedAt: true,
        lastSyncStatus: true,
      },
    }),
    prisma.syncRun.findMany({
      where: tenant
        ? { connectionId: { in: tenantConnectionIds } }
        : { id: "__none__" },
      orderBy: { startedAt: "desc" },
      take: 10,
      select: {
        id: true,
        status: true,
        triggerType: true,
        recordsAdded: true,
        startedAt: true,
        completedAt: true,
        errorMessage: true,
        connection: { select: { displayName: true, systemCode: true } },
      },
    }),
  ]);

  const activeCount = connections.filter((c) => c.status === "ACTIVE").length;
  const errorCount = connections.filter((c) => c.status === "ERROR").length;
  const last24h = recentRuns.filter(
    (r) => r.startedAt.getTime() > Date.now() - 24 * 60 * 60 * 1000
  );
  const recordsLast24h = last24h.reduce((s, r) => s + r.recordsAdded, 0);

  return (
    <div className="flex flex-col gap-6">
      {access && !access.included && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-sm font-medium text-amber-900">
            integrations is not included in your &quot;{access.currentPlan}&quot; plan
          </div>
          <p className="mt-1 text-xs text-amber-700">
            Third-party data connectors (Plaid bank feed, plus Stripe /
            Gusto / Bill.com in future) are part of the Scale tier.
            Existing connection metadata stays visible, but new syncs
            are refused (or warned in dev). Upgrade at{" "}
            <code className="font-mono">/admin/billing</code> in ledger-core.
          </p>
        </div>
      )}
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Integrations</h1>
        <p className="text-sm text-ink-500">
          Third-party data feeds into ledger-core, recon, and revenue-rec.
          v0.1 ships Plaid for bank-feed ingestion into recon.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Connections" value={String(connections.length)} />
        <Metric
          label="Active"
          value={String(activeCount)}
          hint={errorCount > 0 ? `${errorCount} in error` : undefined}
        />
        <Metric
          label="Syncs (24h)"
          value={String(last24h.length)}
        />
        <Metric
          label="Records (24h)"
          value={recordsLast24h.toLocaleString()}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <span className="text-xs text-ink-500">
            Click a connection to see its sync history + imported records.
          </span>
        </CardHeader>
        <CardContent className={connections.length === 0 ? "" : "p-0"}>
          {connections.length === 0 ? (
            <EmptyState
              title="No connections yet"
              description="Use 'Connect bank' in the sidebar to link a Plaid account."
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {connections.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/connections/${c.id}`}
                    className="flex items-center justify-between px-5 py-3 hover:bg-ink-50"
                  >
                    <div>
                      <div className="text-sm font-medium text-ink-900">
                        {c.displayName}
                      </div>
                      <div className="text-[11px] text-ink-500">
                        <span className="font-mono">{c.systemCode}</span> · last sync{" "}
                        {formatRelativeTime(c.lastSyncedAt)}
                      </div>
                    </div>
                    <Badge
                      tone={
                        c.status === "ACTIVE"
                          ? "positive"
                          : c.status === "ERROR"
                            ? "negative"
                            : c.status === "PAUSED"
                              ? "warning"
                              : "neutral"
                      }
                    >
                      {c.status}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent sync activity</CardTitle>
          <span className="text-xs text-ink-500">10 most recent runs across all connections.</span>
        </CardHeader>
        <CardContent className={recentRuns.length === 0 ? "" : "p-0"}>
          {recentRuns.length === 0 ? (
            <EmptyState
              title="No syncs run yet"
              description="Connect a bank and the initial sync will appear here."
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {recentRuns.map((r) => (
                <li key={r.id} className="flex items-start justify-between px-5 py-3">
                  <div>
                    <div className="text-sm text-ink-900">
                      {r.connection.displayName}{" "}
                      <span className="text-[11px] font-mono text-ink-400">
                        ({r.connection.systemCode})
                      </span>
                    </div>
                    <div className="text-[11px] text-ink-500">
                      {r.recordsAdded} record{r.recordsAdded === 1 ? "" : "s"} ·{" "}
                      <span className="font-mono">{r.triggerType}</span> ·{" "}
                      {formatRelativeTime(r.startedAt)}
                    </div>
                    {r.errorMessage && (
                      <div className="mt-1 max-w-2xl text-[11px] text-negative">
                        {r.errorMessage}
                      </div>
                    )}
                  </div>
                  <Badge
                    tone={
                      r.status === "SUCCESS"
                        ? "positive"
                        : r.status === "FAILURE"
                          ? "negative"
                          : r.status === "PARTIAL_SUCCESS"
                            ? "warning"
                            : "neutral"
                    }
                  >
                    {r.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="px-5 py-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
          {label}
        </div>
        <div className="mt-1 text-lg font-semibold text-ink-900">{value}</div>
        {hint && <div className="mt-0.5 text-[11px] text-warning">{hint}</div>}
      </CardContent>
    </Card>
  );
}
