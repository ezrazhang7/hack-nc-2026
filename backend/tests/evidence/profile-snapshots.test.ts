import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { linkedinProfileKey, loadProfileSnapshots } from "../../src/evidence/research/profile-snapshots.js";

const demoFixture = fileURLToPath(new URL("../../fixtures/demo-linkedin-snapshot.json", import.meta.url));

describe("profile snapshots", () => {
  it("matches every common variant of one LinkedIn profile URL", () => {
    const key = "linkedin:linhua-zhou-31948b42b";
    for (const url of [
      "https://www.linkedin.com/in/linhua-zhou-31948b42b/",
      "http://linkedin.com/in/Linhua-Zhou-31948b42b",
      "https://uk.linkedin.com/in/linhua-zhou-31948b42b?utm_source=share#top",
    ]) {
      expect(linkedinProfileKey(url)).toBe(key);
    }
    expect(linkedinProfileKey("https://www.linkedin.com/company/asterlo")).toBeNull();
    expect(linkedinProfileKey("https://linkedin.com.evil.com/in/linhua-zhou-31948b42b")).toBeNull();
    expect(linkedinProfileKey("not a url")).toBeNull();
  });

  it("loads the demo fixture and looks it up by any variant of the URL", async () => {
    const lookup = await loadProfileSnapshots([demoFixture]);
    const snapshot = await lookup("https://linkedin.com/in/linhua-zhou-31948b42b");
    expect(snapshot?.text).toContain("Campus Decoder");
    expect(snapshot?.capturedAt).toBe("2026-10-10");
    expect(await lookup("https://www.linkedin.com/in/someone-else")).toBeNull();
  });

  it("rejects snapshot files that are not founder-provided LinkedIn profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snapshots-"));
    const notLinkedin = join(dir, "a.json");
    writeFileSync(notLinkedin, JSON.stringify({ profile_url: "https://example.com/me", provided_by: "founder", captured_at: "2026-10-10", text: "x" }));
    await expect(loadProfileSnapshots([notLinkedin])).rejects.toThrow(/LinkedIn \/in\/ profile/);
    const scraped = join(dir, "b.json");
    writeFileSync(scraped, JSON.stringify({ profile_url: "https://www.linkedin.com/in/a", provided_by: "scraper", captured_at: "2026-10-10", text: "x" }));
    await expect(loadProfileSnapshots([scraped])).rejects.toThrow();
  });
});
