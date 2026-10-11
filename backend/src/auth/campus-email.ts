import { createHmac } from "node:crypto";

// A bare TLD is allowed: "edu" accepts every *.edu address.
const DOMAIN_PATTERN = /^(?:[a-z0-9-]+\.)*[a-z]{2,}$/;

/** Better Auth also lowercases emails; normalizing here keeps hashes and domain checks aligned. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** CAMPUS_EMAIL_DOMAINS=* accepts any email domain (the demo default: sign-up needs no campus address). */
export const ANY_DOMAIN = "*";

/** DEMO_MODE guest accounts: typed text that is not an email maps to a stable address under this reserved TLD. */
export const GUEST_EMAIL_DOMAIN = "guest.prospecto.invalid";

/** Parses CAMPUS_EMAIL_DOMAINS ("*", "edu", or "unc.edu,duke.edu"). Throws so a misconfigured server fails at startup. */
export function parseCampusDomains(raw: string): string[] {
  if (raw.trim() === ANY_DOMAIN) return [ANY_DOMAIN];
  const domains = raw
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
  if (domains.length === 0) {
    throw new Error("CAMPUS_EMAIL_DOMAINS is empty; set it to edu or a comma-separated list such as unc.edu,duke.edu");
  }
  for (const domain of domains) {
    if (!DOMAIN_PATTERN.test(domain)) {
      throw new Error(`CAMPUS_EMAIL_DOMAINS contains an invalid domain: ${domain}`);
    }
  }
  return domains;
}

/** Accepts an allowed domain or any of its subdomains (cs.unc.edu for unc.edu); with "*", any domain. */
export function isCampusEmail(email: string, domains: readonly string[]): boolean {
  const normalized = normalizeEmail(email);
  const at = normalized.indexOf("@");
  if (at <= 0 || at !== normalized.lastIndexOf("@")) return false;
  const domain = normalized.slice(at + 1);
  if (domains.includes(ANY_DOMAIN)) return DOMAIN_PATTERN.test(domain);
  return domains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

/** Keyed hash stored as identities.campus_email_hash; the raw address stays in auth."user". */
export function campusEmailHash(email: string, pepper: string): string {
  return createHmac("sha256", pepper).update(normalizeEmail(email)).digest("hex");
}

/**
 * DEMO_MODE sign-in input: a well-formed email is used as typed; any other text maps to a stable guest
 * address (same text → same account); blank input gets a fresh guest. Proves nothing about the user.
 */
export function demoSignInEmail(input: string | undefined, randomId: () => string): string {
  const typed = normalizeEmail(input ?? "");
  const at = typed.indexOf("@");
  if (at > 0 && at === typed.lastIndexOf("@") && DOMAIN_PATTERN.test(typed.slice(at + 1))) return typed;
  const local = typed ? createHmac("sha256", "prospecto-demo-guest").update(typed).digest("hex").slice(0, 24) : `guest-${randomId()}`;
  return `${local}@${GUEST_EMAIL_DOMAIN}`;
}
