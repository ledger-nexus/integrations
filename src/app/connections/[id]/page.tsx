// Connection detail. Shows connection metadata, the most recent
// imported BankStatement (so users can verify the Plaid feed
// is producing real data), and the full SyncRun history.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney, formatRelativeTime } from "@/lib/utils/format";
import { TriggerSyncButton } from "../trigger-sync-button";
import { ScheduleControls } from "./schedule-controls";
import { describeNextRun } from "@/lib/sync/scheduler";
import { describeBackoffState } from "@/lib/sync/backoff";
import { getCurrentTenant } from "@/lib/auth/session";

export default async function ConnectionDetailPage({
  params,
}: {
  params: { id: string };
}) {
  // SECURITY (pen-test pass 4 follow-up): tenant-scope the read.
  // Without this, a signed-in user could navigate to /connections/[any-id]
  // and read the institution name, masked external account, full sync
  // history, and imported statement metadata of another tenant's bank
  // connection. The masked accountId helps but is not protection — the
  // displayName already includes the bank + last4.
  const tenant = await getCurrentTenant();
  if (!tenant) notFound();
  const connection = await prisma.connection.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      systemCode: true,
      displayName: true,
      status: true,
      targetType: true,
      targetId: true,
      lastCursor: true,
      lastSyncedAt: true,
      lastSyncStatus: true,
      scheduleEnabled: true,
      syncIntervalMinutes: true,
      nextSyncAt: true,
      lastScheduledRunAt: true,
      consecutiveFailureCount: true,
      createdAt: true,
      credentialsJson: true,
      syncRuns: {
        orderBy: { startedAt: "desc" },
        take: 25,
        select: {
          id: true,
          status: true,
          triggerType: true,
          recordsAdded: true,
          startedAt: true,
          completedAt: true,
          errorMessage: true,
        },
      },
    },
  });
  if (!connection) notFound();

  // Tenant check via the same chain triggerSyncAction uses:
  // Connection.targetId → BankAccount → entity.tenantId. Connection
  // has no tenantId column itself, so this is the canonical join.
  if (connection.targetType === "BANK_ACCOUNT" && connection.targetId) {
    const bankAccount = await prisma.bankAccount.findFirst({
      where: { id: connection.targetId, entity: { tenantId: tenant.id } },
      select: { id: true },
    });
    if (!bankAccount) notFound();
  } else {
    // Unknown targetType — no tenant-resolution path yet. Refuse rather
    // than leak. (v0.2 PARTY / GL_ACCOUNT targets will add branches.)
    notFound();
  }

  // Pull a few of the most recent BankStatement entries imported from this connection.
  // Filter via filename pattern (plaid-sync-<runId>.json — see recon-bridge.ts).
  const recentStatements = connection.targetId
    ? await prisma.bankStatement.findMany({
        where: {
          bankAccountId: connection.targetId,
          format: "PLAID_SYNC_V1",
        },
        orderBy: { uploadedAt: "desc" },
        take: 5,
        select: {
          id: true,
          filename: true,
          uploadedAt: true,
          periodStart: true,
          periodEnd: true,
          totalLines: true,
          closingBalance: true,
        },
      })
    : [];

  // Extract a few safe credential fields for display. NEVER show the
  // accessToken — that's the secret. Display only the institution name,
  // mask the account id.
  const creds = connection.credentialsJson as Record<string, unknown>;
  const institutionName = (creds.institutionName as string | undefined) ?? "—";
  const accountIdMasked = creds.accountId
    ? `••• ${String(creds.accountId).slice(-6)}`
    : "—";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/connections"
          className="text-xs font-medium text-accent-600 hover:underline"
        >
          ← All connections
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-ink-900">{connection.displayName}</h2>
        <p className="text-sm text-ink-500">
          <span className="font-mono">{connection.systemCode}</span> ·{" "}
          {connection.targetType} ·{" "}
          {connection.lastSyncedAt
            ? `last synced ${formatRelativeTime(connection.lastSyncedAt)}`
            : "never synced"}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Card>
          <CardContent className="px-5 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Status
            </div>
            <div className="mt-1">
              <Badge
                tone={
                  connection.status === "ACTIVE"
                    ? "positive"
                    : connection.status === "ERROR"
                      ? "negative"
                      : connection.status === "PAUSED"
                        ? "warning"
                        : "neutral"
                }
              >
                {connection.status}
              </Badge>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-5 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Institution
            </div>
            <div className="mt-1 text-sm text-ink-900">{institutionName}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-5 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              External account
            </div>
            <div className="mt-1 font-mono text-xs text-ink-700">{accountIdMasked}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-5 py-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Manual sync
            </div>
            <div className="mt-1">
              <TriggerSyncButton connectionId={connection.id} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Auto-sync schedule</CardTitle>
          <span className="text-xs text-ink-500">
            When enabled, the Vercel Cron tick (every 5 min) picks this
            connection up at its configured interval and runs a sync via
            the standard runner. Webhook-triggered syncs and manual "Sync
            now" still work alongside.
          </span>
        </CardHeader>
        <CardContent>
          <ScheduleControls
            connectionId={connection.id}
            scheduleEnabled={connection.scheduleEnabled}
            syncIntervalMinutes={connection.syncIntervalMinutes}
            nextSyncAt={connection.nextSyncAt?.toISOString() ?? null}
            lastScheduledRunAt={connection.lastScheduledRunAt?.toISOString() ?? null}
            nextRunDescription={describeNextRun({
              scheduleEnabled: connection.scheduleEnabled,
              syncIntervalMinutes: connection.syncIntervalMinutes,
              nextSyncAt: connection.nextSyncAt,
              status: connection.status,
              lastSyncStatus: connection.lastSyncStatus,
            })}
            consecutiveFailureCount={connection.consecutiveFailureCount}
            backoffDescription={describeBackoffState({
              baseIntervalMinutes: connection.syncIntervalMinutes ?? 60,
              consecutiveFailureCount: connection.consecutiveFailureCount,
            })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent imported statements</CardTitle>
          <span className="text-xs text-ink-500">
            Each Plaid sync produces a recon BankStatement. Lines feed recon's
            matcher; click the filename to see them in recon.
          </span>
        </CardHeader>
        <CardContent className={recentStatements.length === 0 ? "" : "p-0"}>
          {recentStatements.length === 0 ? (
            <EmptyState
              title="No statements imported yet"
              description="Click 'Sync now' to pull transactions from Plaid into recon."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Filename</TH>
                  <TH>Period</TH>
                  <TH className="text-right">Lines</TH>
                  <TH className="text-right">Closing</TH>
                  <TH>Imported</TH>
                </tr>
              </THead>
              <TBody>
                {recentStatements.map((s) => (
                  <TR key={s.id}>
                    <TD className="font-mono text-xs text-ink-700">{s.filename}</TD>
                    <TD className="text-xs text-ink-500">
                      {formatDate(s.periodStart)} → {formatDate(s.periodEnd)}
                    </TD>
                    <TD className="text-right text-ink-700">{s.totalLines}</TD>
                    <TD className="amount-cell text-right">
                      {formatMoney(s.closingBalance.toString())}
                    </TD>
                    <TD className="text-xs text-ink-500">
                      {formatRelativeTime(s.uploadedAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sync history</CardTitle>
          <span className="text-xs text-ink-500">
            25 most recent runs. RUNNING means a sync is in progress.
          </span>
        </CardHeader>
        <CardContent className={connection.syncRuns.length === 0 ? "" : "p-0"}>
          {connection.syncRuns.length === 0 ? (
            <EmptyState title="No sync runs yet" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Started</TH>
                  <TH>Trigger</TH>
                  <TH className="text-right">Records</TH>
                  <TH>Duration</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {connection.syncRuns.map((r) => {
                  const durationMs =
                    r.completedAt && r.startedAt
                      ? r.completedAt.getTime() - r.startedAt.getTime()
                      : null;
                  return (
                    <TR key={r.id}>
                      <TD className="text-xs text-ink-500">
                        {formatRelativeTime(r.startedAt)}
                      </TD>
                      <TD className="font-mono text-xs">{r.triggerType}</TD>
                      <TD className="text-right text-ink-700">{r.recordsAdded}</TD>
                      <TD className="text-xs text-ink-500">
                        {durationMs !== null
                          ? durationMs > 1000
                            ? `${(durationMs / 1000).toFixed(1)}s`
                            : `${durationMs}ms`
                          : "—"}
                      </TD>
                      <TD>
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
                        {r.errorMessage && (
                          <div className="mt-1 max-w-md text-[10px] text-negative">
                            {r.errorMessage}
                          </div>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
