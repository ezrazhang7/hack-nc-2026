import { describe, expect, it } from "vitest";

import { compareDecimal, differsBeyond, normalizeDecimal, numbersInText, valueAppearsInText } from "../../src/evidence/decimal.js";
import { classifyUrl, isFounderControlled, normalizeUrl, siteKey } from "../../src/evidence/research/urls.js";

describe("decimal", () => {
  it("normalizes and compares exactly", () => {
    expect(normalizeDecimal("0012.5000")).toBe("12.5");
    expect(normalizeDecimal("-0")).toBe("0");
    expect(compareDecimal("0.1", "0.10")).toBe(0);
    expect(compareDecimal("99999999999999999999.9", "100000000000000000000")).toBe(-1);
    expect(() => normalizeDecimal("1e5")).toThrow();
  });

  it("extracts stated numbers with separators and suffixes", () => {
    const found = numbersInText("We hit $12.5k MRR, 5,000 users, 40% retention and a $3.2 billion market over 12 months.");
    for (const value of ["12500", "5000", "40", "3200000000", "12"]) expect(found.has(value)).toBe(true);
    expect(found.has("12000000")).toBe(false); // "12 months" is not "12m"
  });

  it("requires the claimed value to literally appear in the quote", () => {
    expect(valueAppearsInText("1200", "Over 1,200 students signed up")).toBe(true);
    expect(valueAppearsInText("12000", "Over 1,200 students signed up")).toBe(false);
  });

  it("detects disagreement beyond a tolerance with integer math", () => {
    expect(differsBeyond("100", "120", 25n)).toBe(false);
    expect(differsBeyond("100", "140", 25n)).toBe(true);
    expect(differsBeyond("0", "0", 25n)).toBe(false);
  });
});

describe("urls", () => {
  it("normalizes and rejects non-public forms", () => {
    expect(normalizeUrl("HTTPS://WWW.Mothlight.app/?utm_source=x#top")).toBe("https://www.mothlight.app/");
    expect(normalizeUrl("https://mothlight.app/about/")).toBe("https://mothlight.app/about");
    expect(normalizeUrl("ftp://mothlight.app")).toBeNull();
    expect(normalizeUrl("https://user:pw@mothlight.app")).toBeNull();
    expect(normalizeUrl("https://mothlight.app:8443")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });

  it("derives site keys", () => {
    expect(siteKey("app.mothlight.app")).toBe("mothlight.app");
    expect(siteKey("www.mothlight.co.uk")).toBe("mothlight.co.uk");
  });

  it("classifies link types", () => {
    expect(classifyUrl("https://github.com/mothlight/app")).toEqual({ kind: "github", owner: "mothlight", repo: "app" });
    expect(classifyUrl("https://github.com/mothlight")).toEqual({ kind: "github", owner: "mothlight", repo: null });
    expect(classifyUrl("https://www.linkedin.com/in/ana")).toEqual({ kind: "unsupported", reason: "LOGIN_REQUIRED" });
    expect(classifyUrl("https://docs.google.com/document/d/x")).toEqual({ kind: "unsupported", reason: "GOOGLE_WORKSPACE" });
    expect(classifyUrl("https://techcrunch.com/a")).toEqual({ kind: "web" });
  });

  it("treats the founder's domain and self-publishing hosts as founder-controlled", () => {
    expect(isFounderControlled("https://blog.mothlight.app/post", "mothlight.app")).toBe(true);
    expect(isFounderControlled("https://mothlight.notion.site/deck", "mothlight.app")).toBe(true);
    expect(isFounderControlled("https://dailytarheel.com/article/x", "mothlight.app")).toBe(false);
  });
});

import { isDirectoryListing, projectSiteKeyFor } from "../../src/evidence/research/urls.js";
describe("directory listings as the website", () => {
  it("are not the founder's own site", () => {
    expect(isDirectoryListing("https://www.ycombinator.com/companies/quippy")).toBe(true);
    expect(projectSiteKeyFor("https://www.ycombinator.com/companies/quippy")).toBeNull();
    expect(projectSiteKeyFor("https://apps.apple.com/us/app/quippy/id1")).toBeNull();
    expect(projectSiteKeyFor("https://mothlight.app/")).toBe("mothlight.app");
    expect(projectSiteKeyFor(null)).toBeNull();
  });
});
