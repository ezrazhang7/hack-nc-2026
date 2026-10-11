import { describe, expect, it } from "vitest";

import { parseTickerReply } from "../src/projects/ticker-ai.js";
import { tickerCandidates } from "../src/projects/ticker.js";

describe("Gemini ticker reply", () => {
  it("keeps 2–4 letter symbols, uppercased and de-duplicated, best first", () => {
    expect(parseTickerReply(JSON.stringify({ ticker: "luna", alternatives: ["MOON", "LUNA", "MOONLT", "M0ON", "L", 7] }))).toEqual(["LUNA", "MOON"]);
  });
  it("returns nothing for malformed output", () => {
    expect(parseTickerReply("not json")).toEqual([]);
    expect(parseTickerReply(JSON.stringify({ ticker: "TOOLONG" }))).toEqual([]);
  });
  it("deterministic fallback still suggests from the name", () => {
    expect(tickerCandidates("Quippy")[0]).toBe("QPY");
  });
});
