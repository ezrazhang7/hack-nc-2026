import Link from "next/link";

const TABS = [
  { href: "/how/", label: "How" },
  { href: "/desk/", label: "Desk" },
  { href: "/rounds/", label: "Back a startup" },
  { href: "/launch/", label: "List" },
  { href: "/news/", label: "News" },
  { href: "/participate/", label: "Invest" },
] as const;

export default function SubHeader({ current }: { current: (typeof TABS)[number]["href"] }) {
  return (
    <header className="page top">
      <Link className="back" href="/"><span>←</span> Front page</Link>
      <Link className="mark" href="/">The Prospecto</Link>
      <nav className="tabs">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} aria-current={t.href === current ? "page" : undefined}>{t.label}</Link>
        ))}
      </nav>
    </header>
  );
}
