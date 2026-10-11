import { describe, expect, test } from "vitest";

import { loadConfig } from "../src/config.js";
import { isAllowedOrigin } from "../src/routes/guards.js";

const baseEnv = {
  PUBLIC_ORIGIN: "https://prospectofunds.tech",
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  BETTER_AUTH_SECRET: "x".repeat(32),
  EMAIL_HASH_PEPPER: "x".repeat(16),
  CAMPUS_EMAIL_DOMAINS: "unc.edu",
  GEMINI_API_KEY: "k",
  GEMINI_MODEL: "m",
  DEMO_MODE: "true",
};

describe("isAllowedOrigin", () => {
  const allowed = ["https://prospectofunds.tech", "https://hack-nc-2026.vercel.app"];

  test("accepts PUBLIC_ORIGIN and each trusted fallback", () => {
    expect(isAllowedOrigin("https://prospectofunds.tech", allowed)).toBe(true);
    expect(isAllowedOrigin("https://hack-nc-2026.vercel.app", allowed)).toBe(true);
    expect(isAllowedOrigin("https://prospectofunds.tech", "https://prospectofunds.tech/")).toBe(true);
  });

  test("rejects missing, look-alike, and other-scheme origins", () => {
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
    expect(isAllowedOrigin("null", allowed)).toBe(false);
    expect(isAllowedOrigin("https://www.prospectofunds.tech", allowed)).toBe(false);
    expect(isAllowedOrigin("http://prospectofunds.tech", allowed)).toBe(false);
    expect(isAllowedOrigin("https://prospectofunds.tech.evil.com", allowed)).toBe(false);
    expect(isAllowedOrigin("https://evil-hack-nc-2026.vercel.app", allowed)).toBe(false);
  });
});

describe("TRUSTED_ORIGINS", () => {
  test("is optional", () => {
    expect(loadConfig(baseEnv).TRUSTED_ORIGINS).toBeUndefined();
  });

  test("parses a comma-separated list of origins", () => {
    const config = loadConfig({ ...baseEnv, TRUSTED_ORIGINS: " https://hack-nc-2026.vercel.app/ , https://b.example " });
    expect(config.TRUSTED_ORIGINS).toEqual(["https://hack-nc-2026.vercel.app", "https://b.example"]);
  });

  test.each(["*.vercel.app", "https://a.example/path", "hack-nc-2026.vercel.app"])("rejects %s", (entry) => {
    expect(() => loadConfig({ ...baseEnv, TRUSTED_ORIGINS: entry })).toThrow(/TRUSTED_ORIGINS/);
  });
});
