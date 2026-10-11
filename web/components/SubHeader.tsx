import Link from "next/link";
import { routes } from "@/lib/routes";

const TABS = [
  { href: routes.how, label: "How" },
  { href: routes.desk, label: "Desk" },
  { href: routes.invest, label: "Invest" },
  { href: routes.portfolio, label: "Portfolio" },
  { href: routes.wallet, label: "Wallet" },
  { href: routes.list, label: "List" },
  { href: routes.manage, label: "Manage" },
  { href: routes.news, label: "News" },
] as const;

export default function SubHeader({ current }: { current: string }) {
  return (
    <header className="page top">
      <Link className="back" href={routes.home}><span>←</span> Front page</Link>
      <Link className="mark" href={routes.home}>The Prospecto</Link>
      <nav className="tabs">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} aria-current={t.href === current ? "page" : undefined}>{t.label}</Link>
        ))}
      </nav>
    </header>
  );
}
