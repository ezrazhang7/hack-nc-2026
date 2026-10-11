import LegacyRouteRedirect from "@/components/LegacyRouteRedirect";

/** Founder controls merged into /wallet/; keep old links (including ?project=) working. */
export default function ManagePage() {
  return <LegacyRouteRedirect kind="manage" />;
}
