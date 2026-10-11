import { describe, expect, it } from "vitest";

import { campusEmailHash, demoSignInEmail, GUEST_EMAIL_DOMAIN, isCampusEmail, parseCampusDomains } from "../../src/auth/campus-email.js";

describe("campus email", () => {
  const domains = parseCampusDomains(" unc.edu , Duke.edu ");

  it("parses and validates the domain list", () => {
    expect(domains).toEqual(["unc.edu", "duke.edu"]);
    expect(() => parseCampusDomains(" , ")).toThrow(/empty/);
    expect(() => parseCampusDomains("unc.edu,not a domain")).toThrow(/invalid domain/);
  });

  it("accepts campus domains and subdomains only", () => {
    expect(isCampusEmail("Student@UNC.edu", domains)).toBe(true);
    expect(isCampusEmail("student@cs.unc.edu", domains)).toBe(true);
    expect(isCampusEmail("student@gmail.com", domains)).toBe(false);
    // Suffix tricks must not pass.
    expect(isCampusEmail("student@notunc.edu", domains)).toBe(false);
    expect(isCampusEmail("student@unc.edu.evil.com", domains)).toBe(false);
    expect(isCampusEmail("a@b@unc.edu", domains)).toBe(false);
    expect(isCampusEmail("@unc.edu", domains)).toBe(false);
  });

  it("accepts every .edu address when configured with the bare TLD", () => {
    const anyEdu = parseCampusDomains("edu");
    expect(anyEdu).toEqual(["edu"]);
    expect(isCampusEmail("student@unc.edu", anyEdu)).toBe(true);
    expect(isCampusEmail("student@cs.duke.edu", anyEdu)).toBe(true);
    expect(isCampusEmail("student@gmail.com", anyEdu)).toBe(false);
    expect(isCampusEmail("student@edu.evil.com", anyEdu)).toBe(false);
    expect(isCampusEmail("student@fakeedu", anyEdu)).toBe(false);
  });

  it("hashes the normalized email with the pepper", () => {
    const hash = campusEmailHash(" Student@UNC.edu ", "pepper-a");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(campusEmailHash("student@unc.edu", "pepper-a"));
    expect(hash).not.toBe(campusEmailHash("student@unc.edu", "pepper-b"));
  });
});

describe("any-domain sign-up and demo guests", () => {
  it('"*" accepts any well-formed email domain', () => {
    const any = parseCampusDomains(" * ");
    expect(any).toEqual(["*"]);
    expect(isCampusEmail("founder@gmail.com", any)).toBe(true);
    expect(isCampusEmail(`x@${GUEST_EMAIL_DOMAIN}`, any)).toBe(true);
    expect(isCampusEmail("a@b@gmail.com", any)).toBe(false);
  });

  it("maps any demo input to a usable address", () => {
    const fresh = () => "11111111-2222-4333-8444-555555555555";
    expect(demoSignInEmail(" Founder@Gmail.com ", fresh)).toBe("founder@gmail.com");
    expect(demoSignInEmail("ezra", fresh)).toBe(demoSignInEmail(" EZRA ", fresh));
    expect(demoSignInEmail("ezra", fresh)).toMatch(new RegExp(`^[a-f0-9]{24}@${GUEST_EMAIL_DOMAIN.replace(/\./g, "\\.")}$`));
    expect(demoSignInEmail("a@b@c", fresh)).toMatch(/@guest\.prospecto\.invalid$/);
    expect(demoSignInEmail(undefined, fresh)).toBe(`guest-${fresh()}@${GUEST_EMAIL_DOMAIN}`);
    expect(demoSignInEmail("", fresh)).toBe(`guest-${fresh()}@${GUEST_EMAIL_DOMAIN}`);
  });

  it("a campus-only server still rejects guest addresses", () => {
    expect(isCampusEmail(demoSignInEmail("ezra", () => "x"), parseCampusDomains("edu"))).toBe(false);
  });
});
