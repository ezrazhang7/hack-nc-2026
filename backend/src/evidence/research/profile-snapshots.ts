// Founder-provided LinkedIn profile snapshots (MARKET ARCHITECTURE §6.5). LinkedIn pages need a
// login and must never be scraped, so a founder can supply their profile text instead. The runner
// treats it as founder-provided text: every claim from it stays FOUNDER_ATTESTED.
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const snapshotFileSchema = z.object({
  profile_url: z.string().url(),
  provided_by: z.literal("founder"),
  captured_at: z.string().date(),
  text: z.string().trim().min(1).max(20_000),
});

export interface ProfileSnapshot {
  profileUrl: string;
  capturedAt: string;
  text: string;
}

export type ProfileSnapshotLookup = (url: string) => Promise<ProfileSnapshot | null>;

/** Keys on the /in/<handle> path, so www/http/trailing-slash/query variants of one profile match. */
export function linkedinProfileKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const match = /^\/in\/([^/]+)\/?$/i.exec(parsed.pathname);
  if (!match) return null;
  try {
    return `linkedin:${decodeURIComponent(match[1]).toLowerCase()}`;
  } catch {
    return null;
  }
}

// Relative paths resolve against backend/, not the process cwd: the cwd differs between local runs
// and Vercel, and only files under backend/ (listed in vercel.json includeFiles) are deployed.
const BACKEND_ROOT = new URL("../../../", import.meta.url);

function resolveSnapshotPath(path: string): string {
  return isAbsolute(path) ? path : fileURLToPath(new URL(path, BACKEND_ROOT));
}

/** Loads snapshot JSON files (e.g. fixtures/demo-linkedin-snapshot.json). Throws on any invalid file. */
export async function loadProfileSnapshots(paths: readonly string[]): Promise<ProfileSnapshotLookup> {
  const byKey = new Map<string, ProfileSnapshot>();
  for (const path of paths) {
    const parsed = snapshotFileSchema.parse(JSON.parse(await readFile(resolveSnapshotPath(path), "utf8")));
    const key = linkedinProfileKey(parsed.profile_url);
    if (!key) throw new Error(`${path}: profile_url must be a LinkedIn /in/ profile URL`);
    byKey.set(key, { profileUrl: parsed.profile_url, capturedAt: parsed.captured_at, text: parsed.text });
  }
  return async (url) => {
    const key = linkedinProfileKey(url);
    return key ? (byKey.get(key) ?? null) : null;
  };
}

/** The canonical form stored in profile_snapshots.profile_url, or null for a non-profile URL. */
export function canonicalLinkedinUrl(url: string): string | null {
  const key = linkedinProfileKey(url);
  return key ? `https://www.linkedin.com/in/${encodeURIComponent(key.slice("linkedin:".length))}` : null;
}

interface Queryable {
  query<R extends object>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Snapshots founders saved through the API (profile_snapshots), limited to people on this
 * project, so nobody's profile text is used for a project they are not part of.
 */
export function dbProfileSnapshotLookup(db: Queryable, projectId: string): ProfileSnapshotLookup {
  return async (url) => {
    const canonical = canonicalLinkedinUrl(url);
    if (!canonical) return null;
    const { rows } = await db.query<{ profile_url: string; captured_at: Date; text: string }>(
      `select s.profile_url, s.captured_at, s.text
         from profile_snapshots s
        where s.profile_url = $1 and s.deleted_at is null
          and s.identity_id in (select founder_identity_id from projects where id = $2
                                union select identity_id from project_members where project_id = $2)
        order by s.captured_at desc
        limit 1`,
      [canonical, projectId],
    );
    const row = rows[0];
    return row ? { profileUrl: row.profile_url, capturedAt: row.captured_at.toISOString().slice(0, 10), text: row.text } : null;
  };
}
