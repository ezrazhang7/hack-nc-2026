// Deterministic verifier: turns Gemini proposals and collector output into evidence proposals
// with an evidence_status. This module, not Gemini, decides trust (BACKEND_STACK §1, M§2.4).
// Rules are documented in docs/EVIDENCE_RESEARCH.md §4; keep the two in sync.
import { createHash } from "node:crypto";

import { compareDecimal, differsBeyond, isDecimal, isInteger, normalizeDecimal, valueAppearsInText } from "../decimal.js";
import { METRICS, PRODUCT_STATUSES, SUBJECT_METRICS, assessmentMetricCode, isMetricCode, type MetricCode } from "../metrics.js";
import type { CorroborationPassOutput, ProposedClaim } from "./gemini.js";
import type { CollectedClaim } from "./github.js";
import type { FetchStatus } from "./safe-fetch.js";
import { hostOf, normalizeUrl } from "./urls.js";

export const VERIFIER_VERSION = "verifier-v4";

export type EvidenceStatus =
  | "INDEPENDENTLY_VERIFIED"
  | "REVIEWER_VERIFIED"
  | "PUBLIC_WEAK"
  | "FOUNDER_ATTESTED"
  | "AI_ASSESSED"
  | "MISSING_OR_CONTRADICTED";

export type SourceType = "FOUNDER_STATEMENT" | "LINK" | "INTEGRATION" | "AI_ASSESSMENT";

export interface SourceRecord {
  url: string;
  finalUrl: string | null;
  origin: "FOUNDER_SUBMITTED" | "SEARCH_CITATION";
  founderControlled: boolean;
  fetchStatus: FetchStatus | "NOT_FETCHED" | "UNSUPPORTED_LINK";
  text: string | null;
  /** True when Gemini's grounding metadata (url_citation / url_context_result) named this URL. */
  groundingSeen: boolean;
  /** Text is the whole source (a founder-provided snapshot), so a missing quote is absent, never unverifiable. */
  complete?: boolean;
}

export interface VerifyInput {
  /** founderNames: listing names (project_members.display_name), used to attribute prior ventures. */
  project: { name: string; siteKey: string | null; founderNames?: string[] };
  founderText: string | null;
  sources: SourceRecord[];
  founderClaims: ProposedClaim[];
  corroborationClaims: ProposedClaim[];
  assessments: CorroborationPassOutput["assessments"];
  collected: CollectedClaim[];
}

export interface EvidenceProposal {
  id: string;
  metric_code: string;
  /** The prior venture a prior_venture_* claim describes; null means this startup. */
  subject: string | null;
  value_numeric: string | null;
  value_text: string | null;
  period_end: string | null;
  source_type: SourceType;
  source_url: string | null;
  quote: string | null;
  status: EvidenceStatus;
  /** Recorded as the evidence_verifications note, e.g. "system:quote-check". */
  method: string;
  reasons: string[];
  /** Only the founder's own low-confidence statements may be dropped at review (EVIDENCE_RESEARCH §5). */
  droppable: boolean;
}

export interface RejectedProposal {
  origin: "founder_pass" | "corroboration_pass" | "assessment";
  metric_code: string;
  source_url: string | null;
  reason: string;
}

export interface VerifyResult {
  proposals: EvidenceProposal[];
  rejected: RejectedProposal[];
}

// Pages whose readable text is shorter than this are treated as unverifiable (typically
// client-rendered apps), not as evidence that the quote is absent.
const MIN_VERIFIABLE_TEXT = 200;
// Two values for the same metric and period disagree when they differ by more than this percent.
const CONTRADICTION_TOLERANCE_PCT = 25n;
const MARKET_METRICS = new Set<string>(["tam_usd", "market_growth_pct"]);
// Backstop only: the closed metric vocabulary is the primary pedigree control (M§2.3).
const PEDIGREE_PATTERN =
  /\b(ivy league|alma mater|gpa|graduated from|degree from|prestigious|elite (?:school|university|college)|top[- ]tier (?:school|university|college)|gender|race|ethnicity|nationality|family background)\b/i;

const STATUS_RANK: Record<EvidenceStatus, number> = {
  INDEPENDENTLY_VERIFIED: 5,
  REVIEWER_VERIFIED: 4,
  PUBLIC_WEAK: 3,
  AI_ASSESSED: 2,
  FOUNDER_ATTESTED: 1,
  MISSING_OR_CONTRADICTED: 0,
};

export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

type QuoteState = "verified" | "absent" | "unverifiable";

function quoteState(quote: string, source: SourceRecord): QuoteState {
  if (source.fetchStatus !== "OK" || !source.text) return "unverifiable";
  const haystack = normalizeForMatch(source.text);
  if (haystack.includes(normalizeForMatch(quote))) return "verified";
  return haystack.length < MIN_VERIFIABLE_TEXT && !source.complete ? "unverifiable" : "absent";
}

function mentions(text: string, needle: string): boolean {
  const n = normalizeForMatch(needle);
  return n.length >= 3 && normalizeForMatch(text).includes(n);
}

function proposalId(parts: (string | null)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

// verifier-v2: founders describe a shipped product ("built and shipped X", "live at x.com"), not a
// count, so prior_shipped_products = 1 may rest on a shipping verb in the verbatim quote. Larger
// counts still need the number written out. The quote itself is still checked against its source.
const SHIPPED_ONE = /\b(shipped|deployed|launched|released|published|live at)\b/i;

/**
 * verifier-v3 (metrics-v3): prior-venture claims must name the venture, and the venture's name
 * must appear in the source we checked. Returns the subject (null for other metrics) or a reason.
 */
function subjectOf(code: MetricCode, claim: ProposedClaim, sourceText: string | null): string | null | { reason: string } {
  if (!SUBJECT_METRICS.has(code)) return null;
  const subject = claim.subject?.trim();
  if (!subject) return { reason: "SUBJECT_REQUIRED" };
  if (sourceText !== null && !mentions(sourceText, subject)) return { reason: "SUBJECT_NOT_IN_SOURCE" };
  if (describesEmployment(claim.quote, subject)) return { reason: "EMPLOYMENT_NOT_VENTURE" };
  return subject;
}

const ROLE = "(?:head|director|vp|vice president|manager|engineer|intern|analyst|designer|lead|apm|pm|associate|consultant|scientist|developer|researcher|staff|member)";

/**
 * verifier-v4: a quote that describes a job at the "venture" ("Head of Product at Luvu", "APM at
 * Duolingo") is employment, not a company the founder built; its users and revenue are not theirs.
 */
export function describesEmployment(quote: string, subject: string): boolean {
  const name = subject.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${ROLE}\\b[^.;]{0,60}?\\b(?:at|@)\\s+${name}\\b`, "i").test(quote);
}

/** A page attributes a prior venture to this team only if it names the venture and a founder. */
function namesVentureAndFounder(text: string, subject: string, founderNames: readonly string[]): boolean {
  return mentions(text, subject) && founderNames.some((name) => mentions(text, name));
}

/** The prior venture's own site is self-published, like this startup's (e.g. acme.io for "Acme"). */
function isVentureOwnSite(url: string, subject: string): boolean {
  const slug = subject.toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug.length >= 3 && hostOf(url).replace(/[^a-z0-9.]/g, "").split(".").some((label) => label === slug);
}

/** Validates the value against the metric's kind and range; returns [value_numeric, value_text] or a reason. */
function validateValue(code: MetricCode, value: string, quote: string): [string | null, string | null] | string {
  const definition = METRICS[code];
  if (definition.kind === "product_status") {
    const status = value.trim().toLowerCase();
    return (PRODUCT_STATUSES as readonly string[]).includes(status) ? [null, status] : "INVALID_VALUE";
  }
  const trimmed = value.trim();
  if (!isDecimal(trimmed)) return "INVALID_VALUE";
  if (definition.kind === "integer" && !isInteger(trimmed)) return "INVALID_VALUE";
  if ("min" in definition && compareDecimal(trimmed, definition.min) < 0) return "OUT_OF_RANGE";
  if ("max" in definition && compareDecimal(trimmed, definition.max) > 0) return "OUT_OF_RANGE";
  // Anti-hallucination: the number must literally appear in the cited excerpt.
  const shippedOne = code === "prior_shipped_products" && compareDecimal(trimmed, "1") === 0 && SHIPPED_ONE.test(quote);
  if (!shippedOne && !valueAppearsInText(trimmed, quote)) return "VALUE_NOT_IN_QUOTE";
  return [normalizeDecimal(trimmed), null];
}

export function verifyResearch(input: VerifyInput): VerifyResult {
  const rejected: RejectedProposal[] = [];
  const proposals: EvidenceProposal[] = [];

  // verifier-v4: a page's own URL beats another source's redirect target, and a founder-submitted
  // page beats a search citation that redirects to it (a Google grounding link resolving to the
  // founder's YC page used to replace it, so every claim from that page was rejected as unknown).
  const byUrl = new Map<string, SourceRecord>();
  const rank = (s: SourceRecord) => (s.origin === "FOUNDER_SUBMITTED" ? 0 : 1);
  for (const pass of ["url", "finalUrl"] as const) {
    for (const source of input.sources) {
      const key = source[pass];
      if (!key) continue;
      const held = byUrl.get(key);
      if (!held || (pass === "finalUrl" && held.url !== key && rank(source) < rank(held))) byUrl.set(key, source);
    }
  }
  const findSource = (raw: string): SourceRecord | null => {
    const normalized = normalizeUrl(raw);
    if (!normalized) return null;
    const direct = byUrl.get(normalized);
    if (direct) return direct;
    const url = new URL(normalized);
    url.hostname = url.hostname.startsWith("www.") ? url.hostname.slice(4) : `www.${url.hostname}`;
    return byUrl.get(url.toString()) ?? null;
  };

  const push = (proposal: Omit<EvidenceProposal, "id">) =>
    proposals.push({
      id: proposalId([proposal.metric_code, proposal.subject, proposal.value_numeric, proposal.value_text, proposal.source_url, proposal.quote, proposal.source_type]),
      ...proposal,
    });

  // Founder pass: the founder's own links and text.
  for (const claim of input.founderClaims) {
    const reject = (reason: string) =>
      rejected.push({ origin: "founder_pass", metric_code: claim.metric_code, source_url: claim.source_url, reason });
    if (!isMetricCode(claim.metric_code)) {
      reject("UNKNOWN_METRIC");
      continue;
    }
    const value = validateValue(claim.metric_code, claim.value, claim.quote);
    if (typeof value === "string") {
      reject(value);
      continue;
    }
    const base = {
      metric_code: claim.metric_code,
      subject: null as string | null,
      value_numeric: value[0],
      value_text: value[1],
      period_end: claim.period_end,
      quote: claim.quote,
    };

    if (claim.source_url === "founder_text") {
      if (!input.founderText || !normalizeForMatch(input.founderText).includes(normalizeForMatch(claim.quote))) {
        reject("QUOTE_NOT_IN_SOURCE");
        continue;
      }
      const subject = subjectOf(claim.metric_code, claim, input.founderText);
      if (subject !== null && typeof subject === "object") {
        reject(subject.reason);
        continue;
      }
      base.subject = subject;
      push({ ...base, source_type: "FOUNDER_STATEMENT", source_url: null, status: "FOUNDER_ATTESTED", method: "system:founder-text", reasons: [], droppable: true });
      continue;
    }

    const source = findSource(claim.source_url);
    if (!source || source.origin !== "FOUNDER_SUBMITTED") {
      reject("UNKNOWN_SOURCE");
      continue;
    }
    const state = quoteState(claim.quote, source);
    if (state === "absent") {
      reject("QUOTE_NOT_IN_SOURCE");
      continue;
    }
    const subject = subjectOf(claim.metric_code, claim, state === "verified" ? source.text : null);
    if (subject !== null && typeof subject === "object") {
      reject(subject.reason);
      continue;
    }
    base.subject = subject;
    const reasons = state === "unverifiable" ? ["QUOTE_UNVERIFIABLE"] : [];
    const attributed =
      source.text !== null &&
      (subject !== null ? namesVentureAndFounder(source.text, subject, input.project.founderNames ?? []) : mentions(source.text, input.project.name));
    if (!source.founderControlled && state === "verified" && attributed && !(subject !== null && isVentureOwnSite(source.url, subject))) {
      push({ ...base, source_type: "LINK", source_url: source.url, status: "PUBLIC_WEAK", method: "system:quote-check;third-party", reasons, droppable: false });
    } else {
      if (!source.founderControlled) reasons.push("THIRD_PARTY_UNCONFIRMED");
      push({ ...base, source_type: "LINK", source_url: source.url, status: "FOUNDER_ATTESTED", method: "system:quote-check;founder-source", reasons, droppable: true });
    }
  }

  // Corroboration pass: third-party pages found by search. Anything not provable is dropped.
  for (const claim of input.corroborationClaims) {
    const reject = (reason: string) =>
      rejected.push({ origin: "corroboration_pass", metric_code: claim.metric_code, source_url: claim.source_url, reason });
    if (!isMetricCode(claim.metric_code)) {
      reject("UNKNOWN_METRIC");
      continue;
    }
    const value = validateValue(claim.metric_code, claim.value, claim.quote);
    if (typeof value === "string") {
      reject(value);
      continue;
    }
    const source = findSource(claim.source_url);
    if (!source) {
      reject("UNKNOWN_SOURCE");
      continue;
    }
    if (source.founderControlled) {
      reject("SELF_PUBLISHED_SOURCE");
      continue;
    }
    const state = quoteState(claim.quote, source);
    if (state !== "verified") {
      reject(state === "absent" ? "QUOTE_NOT_IN_SOURCE" : "QUOTE_UNVERIFIABLE");
      continue;
    }
    const subject = subjectOf(claim.metric_code, claim, source.text);
    if (subject !== null && typeof subject === "object") {
      reject(subject.reason);
      continue;
    }
    if (subject !== null) {
      // Prior ventures: a third-party page must name the venture and one of this team's founders.
      // Common names can still collide; a founder can dispute, and a reviewer decides.
      if (isVentureOwnSite(source.url, subject)) {
        reject("SELF_PUBLISHED_SOURCE");
        continue;
      }
      if (!namesVentureAndFounder(source.text ?? "", subject, input.project.founderNames ?? [])) {
        reject("ENTITY_UNCONFIRMED");
        continue;
      }
    } else if (!MARKET_METRICS.has(claim.metric_code)) {
      // Company-specific facts must name the company and, unless the founder submitted the page,
      // its domain too. Student startups often share names with unrelated companies.
      const text = source.text ?? "";
      const namesCompany = mentions(text, input.project.name);
      const namesDomain = input.project.siteKey !== null && mentions(text, input.project.siteKey);
      // verifier-v4: a startup listed only in a directory (no domain of its own) is identified by a
      // founder's full name instead. Single-word listing names ("me", "Ana") are too weak to count.
      const namesFounder = input.project.siteKey === null
        && (input.project.founderNames ?? []).some((name) => /\S+\s+\S+/.test(name.trim()) && mentions(text, name.trim()));
      if (!namesCompany || (source.origin === "SEARCH_CITATION" && !namesDomain && !namesFounder)) {
        reject("ENTITY_UNCONFIRMED");
        continue;
      }
    }
    push({
      metric_code: claim.metric_code,
      subject,
      value_numeric: value[0],
      value_text: value[1],
      period_end: claim.period_end,
      source_type: "LINK",
      source_url: source.url,
      quote: claim.quote,
      status: "PUBLIC_WEAK",
      method: "system:quote-check;third-party",
      reasons: source.groundingSeen ? ["GROUNDING_CITED"] : [],
      droppable: false,
    });
  }

  // AI assessments of judgment factors: bounded influence via the AI_ASSESSED multiplier.
  for (const assessment of input.assessments) {
    const code = assessmentMetricCode(assessment.subfactor);
    const reject = (reason: string, url: string | null = null) => rejected.push({ origin: "assessment", metric_code: code, source_url: url, reason });
    if (PEDIGREE_PATTERN.test(assessment.rationale)) {
      reject("PEDIGREE_REASONING");
      continue;
    }
    const verified = assessment.citations.find((citation) => {
      const source = findSource(citation.source_url);
      return source !== null && quoteState(citation.quote, source) === "verified";
    });
    if (!verified) {
      reject("NO_VERIFIED_CITATION", assessment.citations[0]?.source_url ?? null);
      continue;
    }
    push({
      metric_code: code,
      subject: null,
      value_numeric: normalizeDecimal(["0", "0.25", "0.5", "0.75", "1"][assessment.level]),
      value_text: assessment.rationale,
      period_end: null,
      source_type: "AI_ASSESSMENT",
      source_url: findSource(verified.source_url)!.url,
      quote: verified.quote,
      status: "AI_ASSESSED",
      method: "system:ai-assessment;quote-check",
      reasons: [],
      droppable: false,
    });
  }

  // Deterministic collectors (GitHub API).
  for (const claim of input.collected) {
    push({
      metric_code: claim.metric_code,
      subject: null,
      value_numeric: normalizeDecimal(claim.value_numeric),
      value_text: claim.detail,
      period_end: null,
      source_type: "INTEGRATION",
      source_url: claim.source_url,
      quote: null,
      status: claim.status,
      method: claim.method,
      reasons: [],
      droppable: false,
    });
  }

  return { proposals: markContradictions(dedupe(proposals)), rejected };
}

function sortKey(proposal: EvidenceProposal): string {
  return `${String(9 - STATUS_RANK[proposal.status])}|${proposal.source_url ?? ""}|${proposal.id}`;
}

function dedupe(proposals: EvidenceProposal[]): EvidenceProposal[] {
  const seen = new Set<string>();
  return [...proposals]
    .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    .filter((proposal) => {
      const key = [proposal.metric_code, proposal.subject ?? "", proposal.value_numeric, proposal.metric_code.startsWith("assessment.") ? "" : proposal.value_text, proposal.period_end, proposal.status].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function disagree(a: EvidenceProposal, b: EvidenceProposal): boolean {
  if (a.value_numeric !== null && b.value_numeric !== null) return differsBeyond(a.value_numeric, b.value_numeric, CONTRADICTION_TOLERANCE_PCT);
  return a.value_text !== b.value_text;
}

/**
 * Within a metric/period group, the highest-ranked claims define the consensus. If they disagree
 * with each other, the whole group is contradicted (neutral prior + reviewer flag); otherwise
 * lower-ranked claims that disagree with the consensus are contradicted.
 */
function markContradictions(proposals: EvidenceProposal[]): EvidenceProposal[] {
  const groups = new Map<string, EvidenceProposal[]>();
  for (const proposal of proposals) {
    if (proposal.source_type === "AI_ASSESSMENT") continue;
    // Different prior ventures are different facts, never contradictions of each other.
    const key = `${proposal.metric_code}|${proposal.subject ?? ""}|${proposal.period_end ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), proposal]);
  }
  const contradicted = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const topRank = Math.max(...group.map((proposal) => STATUS_RANK[proposal.status]));
    const top = group.filter((proposal) => STATUS_RANK[proposal.status] === topRank);
    if (top.some((a) => top.some((b) => disagree(a, b)))) {
      group.forEach((proposal) => contradicted.add(proposal.id));
      continue;
    }
    for (const proposal of group) {
      if (STATUS_RANK[proposal.status] < topRank && disagree(proposal, top[0])) contradicted.add(proposal.id);
    }
  }
  return proposals.map((proposal) =>
    contradicted.has(proposal.id)
      ? {
          ...proposal,
          status: "MISSING_OR_CONTRADICTED",
          method: `${proposal.method};contradiction`,
          reasons: [...proposal.reasons, "CONTRADICTED"],
          droppable: false,
        }
      : proposal,
  );
}
