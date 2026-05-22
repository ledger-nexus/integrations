import Link from "next/link";

export function Sidebar() {
  return (
    <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-ink-200 bg-ink-50 px-3 py-5">
      <div className="px-2 pb-3">
        <div className="text-xs font-medium uppercase tracking-wider text-ink-500">
          integrations
        </div>
        <div className="text-[11px] text-ink-400">AI-assisted data sync · v0.1</div>
        <div className="mt-1 text-[10px] text-ink-400">
          companion to{" "}
          <span className="font-mono">ledger-core</span> ·{" "}
          <span className="font-mono">recon</span>
        </div>
      </div>
      <NavLink href="/">Dashboard</NavLink>
      <NavLink href="/connections">Connections</NavLink>
      <NavLink href="/connections/new">+ Connect bank</NavLink>
    </aside>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-2 py-1.5 text-sm text-ink-700 hover:bg-white hover:text-ink-900"
    >
      {children}
    </Link>
  );
}
