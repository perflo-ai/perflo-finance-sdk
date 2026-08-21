function asciiHttpsAuthority(value: string): string | undefined {
  // ASCII by decision: JS has no ASCII case flag, and `i` folds U+017F to `s`.
  const authority = /^[hH][tT][tT][pP][sS]:\/\/([^/?#]*)(?=[/?#]|$)/u.exec(
    value,
  )?.[1];
  if (
    !authority ||
    [...authority].some((character) => character > "\u007f") ||
    authority.includes("@") ||
    authority.includes("%") ||
    authority.includes("[") ||
    authority.includes("]") ||
    authority.endsWith(":")
  ) {
    return undefined;
  }
  return authority;
}

// The policy answers one question: will a browser open exactly the host this
// string reads as. A browser reads a non-ASCII host, and an `xn--` label, by
// decoding it through the name-encoding standard's tables -- tables that are
// not carried here, and whose contents differ between browser engines and
// between interpreters, so the host such a spelling names is not settled. Only
// a spelling that needs no decoding is allowed: ASCII labels of letters,
// digits and inner hyphens, none of them spelled `xn--`. A name written in
// another script falls back to the configured verification page. One ASCII
// spelling is refused for the same reason, before any parser reads it: a
// bracketed authority. `https://[v1.abc]/s` names the host `v1.abc` to one URL
// parser and no host at all to another.
/**
 * Whether a value is a verification URL the policy allows: an HTTPS URL that
 * states no credentials and names a host of at least two ASCII labels of
 * letters, digits and inner hyphens, none of them `localhost` and none
 * beginning `xn--`, each label at most 63 characters and the host at most 253,
 * with one trailing dot allowed and a final label that is neither all digits
 * nor `0x` hex; a zero or empty port, a percent sign or bracket in the
 * authority, and a backslash, a space or an ASCII control character anywhere
 * are refused. A non-string value returns `false`. Ownership, name resolution
 * and reachability are not checked. It is the rule a `kyc_session` action's
 * `url` is held to, and it is tested against the corpus the source repository
 * shares with the API.
 */
export function isAllowedVerificationUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    [...value].some(
      (character) => character <= "\u0020" || character === "\u007f",
    ) ||
    value.includes("\\") ||
    asciiHttpsAuthority(value) === undefined
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // An ASCII authority leaves `url.hostname` as the lowercased raw host, so it
  // is both the length subject and the label subject. For `https:` it is never
  // empty, which is why nothing below tests for that.
  const labels = url.hostname.replace(/\.$/u, "").split(".");
  const finalLabel = labels.at(-1) ?? "";
  // The last two tests are the whole IP-literal refusal: every decimal and
  // octal spelling of an address ends in digits and every hex spelling ends in
  // `0x…`, while an IPv6 or IPvFuture literal is bracketed, which the
  // authority check refuses before any parser runs. There are no all-numeric
  // top-level names. The `0x…` test is unreachable under a WHATWG parser for
  // every input that survives the authority check: IPv4 parsing has already
  // run on such a final label and has either thrown or rewritten the host to
  // dotted decimal, where the digits test fires. It is kept only so the three
  // implementations read as one rule; the Python twin is the load-bearing one,
  // because `urlsplit` runs no IPv4 parsing at all.
  return !(
    url.port === "0" ||
    url.hostname.length > 253 ||
    labels.length < 2 ||
    labels.includes("localhost") ||
    labels.some((label) => label.length > 63) ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)) ||
    labels.some((label) => label.startsWith("xn--")) ||
    /^\d+$/u.test(finalLabel) ||
    /^0x[0-9a-f]*$/u.test(finalLabel)
  );
}
