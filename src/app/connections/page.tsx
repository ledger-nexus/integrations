// Connections list — full table view with per-row "Sync now" controls.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatRelativeTime } from "@/lib/utils/format";
import { TriggerSyncButton } from "./trigger-sync-button";
import { getCurrentTenant } from "@/lib/auth/session";

export default async function ConnectionsListPage() {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope the enumeration.
  // Connection has no direct tenantId column, so we walk
  // Connection.targetId → BankAccount.entity.tenantId. This mirrors how
  // triggerSyncAction tenant-checks the connection it's about to sync.
  const tenant = await getCurrentTenant();
  const tenantBankAccountIds = tenant
    ? (
        await prisma.bankAccount.findMany({
          where: { entity: { tenantId: tenant.id } },
          select: { id: true },
        })
      ).map((b) => b.id)
    : [];
  const connections = await prisma.connection.findMany({
    where: tenant
      ? { targetType: "BANK_ACCOUNT", targetId: { in: tenantBankAccountIds } }
      : { id: "__none__" },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      systemCode: true,
      displayName: true,
      status: true,
      targetType: true,
      lastSyncedAt: true,
      lastSyncStatus: true,
      scheduleEnabled: true,
      syncIntervalMinutes: true,
      nextSyncAt: true,
      createdAt: true,
      _count: { select: { syncRuns: true } },
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Connections</h1>
          <p className="text-sm text-ink-500">
            {connections.length} connection{connections.length === 1 ? "" : "s"} ·{" "}
            <Link href="/connections/new" className="text-accent-600 hover:underline">
              + Connect new bank
            </Link>
          </p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>All connections</CardTitle>
        </CardHeader>
        <CardContent className={connections.length === 0 ? "" : "p-0"}>
          {connections.length === 0 ? (
            <EmptyState
              title="No connections yet"
              description="Start by connecting a bank account via Plaid."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>System</TH>
                  <TH>Target</TH>
                  <TH>Last sync</TH>
                  <TH>Schedule</TH>
                  <TH className="text-right">Runs</TH>
                  <TH>Status</TH>
                  <TH>Action</TH>
                </tr>
              </THead>
              <TBody>
                {connections.map((c) => (
                  <TR key={c.id}>
                    <TD>
                      <Link
                        href={`/connections/${c.id}`}
                        className="text-ink-900 hover:underline"
                      >
                        {c.displayName}
                      </Link>
                    </TD>
                    <TD>
                      <Badge tone="info">
                        <span className="font-mono">{c.systemCode}</span>
                      </Badge>
                    </TD>
                    <TD className="text-xs font-mono text-ink-600">{c.targetType}</TD>
                    <TD className="text-xs text-ink-500">
                      {formatRelativeTime(c.lastSyncedAt)}
                    </TD>
                    <TD className="text-xs">
                      {c.scheduleEnabled && c.syncIntervalMinutes != null ? (
                        <div className="flex flex-col gap-0.5">
                          <Badge tone="positive">every {c.syncIntervalMinutes}m</Badge>
                          {c.nextSyncAt ? (
                            <span className="text-[10px] text-ink-500">
                              next {formatRelativeTime(c.nextSyncAt)}
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-ink-400">off</span>
                      )}
                    </TD>
                    <TD className="text-right text-xs text-ink-600">
                      {c._count.syncRuns}
                    </TD>
                    <TD>
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
                    </TD>
                    <TD>
                      <TriggerSyncButton connectionId={c.id} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
