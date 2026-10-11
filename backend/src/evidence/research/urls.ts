// URL normalization and provenance classification for evidence research.
// "Founder-controlled" decides the evidence ceiling: anything the founder can publish themselves
// is FOUNDER_ATTESTED no matter how official it looks (EVIDENCE_RESEARCH §4).

// Hosts where anyone can publish content about themselves. A page here is never independent proof.
const SELF_PUBLISHED_SUFFIXES = [
  "github.com",
  "github.io",
  "gitlab.com",
  "notion.site",
  "notion.so",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "framer.website",
  "framer.app",
  "webflow.io",
  "carrd.co",
  "wixsite.com",
  "squarespace.com",
  "sites.google.com",
  "medium.com",
  "substack.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "instagram.com",
  "tiktok.com",
  "facebook.com",
  "youtube.com",
  "figma.com",
  "canva.site",
  "linktr.ee",
  "docsend.com",
];

// Second-level public suffixes common enough to matter for campus startups. Not the full PSL:
// an unknown multi-part suffix only makes the site key broader, which errs toward
// treating a page as founder-controlled (the lower evidence level).
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk",
  "ac.uk",
  "org.uk",
  "com.au",
  "edu.au",
  "co.nz",
  "co.in",
  "co.jp",
  "com.br",
  "com.cn",
  "com.sg",
  "com.mx",
  "co.za",
  "co.kr",
]);

const MAX_URL_LENGTH = 2048;

/** Canonical URL for matching, or null if it is not a plain public http(s) URL. */
export function normalizeUrl(input: string): string | null {
  if (input.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "80" && url.port !== "443") return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || key === "ref" || key === "fbclid" || key === "gclid") {
      url.searchParams.delete(key);
    }
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, "");
}

/** Approximate registrable domain ("app.mothlight.co.uk" → "mothlight.co.uk"). */
export function siteKey(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return TWO_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function isSelfPublishedHost(host: string): boolean {
  return SELF_PUBLISHED_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix));
}

/**
 * Directory and store listings written up by a third party (an accelerator, a database, an app
 * store). A founder may give one as their "website", but it is not the founder's own domain.
 */
const DIRECTORY_SITES = new Set([
  "ycombinator.com", "crunchbase.com", "producthunt.com", "wellfound.com", "angel.co",
  "apps.apple.com", "play.google.com", "devpost.com", "f6s.com",
]);

export function isDirectoryListing(url: string): boolean {
  const host = hostOf(url);
  return DIRECTORY_SITES.has(host) || DIRECTORY_SITES.has(siteKey(host));
}

/** The founder's own site key, or null when the "website" is a third-party directory listing. */
export function projectSiteKeyFor(website: string | null): string | null {
  return website && !isDirectoryListing(website) ? siteKey(hostOf(website)) : null;
}

export function isFounderControlled(url: string, projectSiteKey: string | null): boolean {
  const host = hostOf(url);
  if (projectSiteKey && siteKey(host) === projectSiteKey) return true;
  return isSelfPublishedHost(host);
}

export type UrlClass =
  | { kind: "github"; owner: string; repo: string | null }
  | { kind: "web" }
  | { kind: "unsupported"; reason: "LOGIN_REQUIRED" | "GOOGLE_WORKSPACE" | "VIDEO" };

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const GITHUB_RESERVED = new Set(["orgs", "topics", "features", "marketplace", "sponsors", "settings", "about"]);

export function classifyUrl(url: string): UrlClass {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "");

  if (host === "github.com") {
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    if (owner && GITHUB_NAME.test(owner) && !GITHUB_RESERVED.has(owner.toLowerCase())) {
      const cleanRepo = repo?.replace(/\.git$/, "");
      return { kind: "github", owner, repo: cleanRepo && GITHUB_NAME.test(cleanRepo) ? cleanRepo : null };
    }
  }
  // Gemini URL context cannot read these (ai.google.dev/gemini-api/docs/url-context#limitations);
  // LinkedIn requires login. The founder is told to paste the facts as text instead.
  if (hostMatchesSuffix(host, "linkedin.com")) return { kind: "unsupported", reason: "LOGIN_REQUIRED" };
  if (hostMatchesSuffix(host, "docs.google.com") || hostMatchesSuffix(host, "drive.google.com")) {
    return { kind: "unsupported", reason: "GOOGLE_WORKSPACE" };
  }
  if (hostMatchesSuffix(host, "youtube.com") || host === "youtu.be") {
    return { kind: "unsupported", reason: "VIDEO" };
  }
  return { kind: "web" };
}
