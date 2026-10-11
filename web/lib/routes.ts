/** Canonical browser routes. Backend resource names do not belong in the public IA. */
export const routes = {
  home: "/",
  desk: "/desk/",
  how: "/how/",
  invest: "/invest/",
  portfolio: "/portfolio/",
  wallet: "/wallet/",
  list: "/list/",
  manage: "/manage/",
  news: "/news/",
} as const;

const withQuery = (path: string, key: string, value?: string | null) =>
  value ? `${path}?${key}=${encodeURIComponent(value)}` : path;

export const investHref = (ticker?: string | null) => withQuery(routes.invest, "ticker", ticker?.toUpperCase());
export const investSlugHref = (slug?: string | null) => withQuery(routes.invest, "slug", slug);
export const walletHref = (roundId?: string | null) => withQuery(routes.wallet, "round", roundId);
export const manageHref = (projectId?: string | null) => withQuery(routes.manage, "project", projectId);
