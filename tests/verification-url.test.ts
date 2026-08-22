import { describe, expect, it } from "vitest";
import { isAllowedVerificationUrl } from "../src/index.js";
import verificationUrlCorpus from "../verification-url-corpus.json" with {
  type: "json",
};

describe("isAllowedVerificationUrl", () => {
  // One corpus for the API boundary, the SDK export and the browser copy.
  // Adding a case to a single suite is what let three separate divergences
  // reach review.
  it.each(
    verificationUrlCorpus.accept,
  )("accepts a URL inside the allowed policy: %s", (url) => {
    expect(isAllowedVerificationUrl(url)).toBe(true);
  });

  it.each(
    verificationUrlCorpus.reject,
  )("rejects a URL outside the allowed policy: %s", (url) => {
    expect(isAllowedVerificationUrl(url)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 443],
    ["a URL instance", new URL("https://verify.identity.example/session")],
    ["a string-valued object", { toString: () => "https://a.example/s" }],
    ["an array of one accepted URL", ["https://a.example/s"]],
  ])("rejects %s", (_name, value) => {
    expect(isAllowedVerificationUrl(value)).toBe(false);
  });
});
