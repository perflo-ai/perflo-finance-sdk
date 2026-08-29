# Perflo Finance TypeScript SDK

Use `@perflo/finance-sdk` from Node.js, browsers, or Cloudflare Workers to call the Perflo Finance API with generated operations and types. Preview releases are available as validated GitHub Release tarballs before the package moves to the npm registry.

## Install a preview release

Set the release location once in your shell:

```bash
sdk_version="v0.1.0-beta.15"
sdk_archive="perflo-finance-sdk-0.1.0-beta.15.tgz"
sdk_releases="https://github.com/perflo-ai/perflo-finance-sdk/releases"
```

Install the tarball with pnpm or npm:

```bash
pnpm add "$sdk_releases/download/$sdk_version/$sdk_archive"
# or
npm install "$sdk_releases/download/$sdk_version/$sdk_archive"
```

Node.js 22.18 or later is required for installation and builds. The package is an ECMAScript module (ESM), has no runtime dependencies, and emits no Node builtin imports. Browsers and Workers can use `globalThis.fetch` or inject `fetch` through the client options.

## Create a client

Create one client for each customer or agent credential:

```typescript
import {
  createPerfloClient,
  getIdentity,
  isProblemDetails,
} from "@perflo/finance-sdk";

const client = createPerfloClient({
  token: "customer_access_jwt",
});

const { data, error, response } = await getIdentity({ client });

if (isProblemDetails(error)) {
  console.error(error.code, error.detail, response?.status);
} else if (error) {
  console.error("The identity request failed", response?.status, error);
} else if (data) {
  console.log(data.actor_type, data.subject, data.wallet);
}
```

The `error` field is `unknown` because it can contain a problem document, an unexpected HTTP body, a decode failure, a request-construction failure, or a Fetch failure. Use `isProblemDetails(error)` before reading problem fields. HTTP and decode failures return their response when one exists; request-construction, network, and Fetch failures have no response. Response headers remain available through `response.headers`.

Generated operations always return field-style results. Set `throwOnError` on an individual operation when exception-based handling is useful. Throw mode throws the raw problem, decode error, request-construction error, or Fetch error; a thrown decode error does not retain its HTTP response. Keep the default non-throwing mode when response metadata is required for error handling. Shared `responseStyle` and `throwOnError` changes are rejected because they would invalidate generated return types. Direct transport methods can still select either result style per call.

Generated operations decode their declared successful response as JSON regardless of the server's `Content-Type`. An empty or malformed non-`204` success returns a decode error with its HTTP response instead of fabricated data. A `204` result has `data: undefined`, while a JSON `null` remains `data: null`.

The client omits ambient browser credentials and never follows redirects. Redirects return through `error` and `response` as non-ok results. Node.js and Cloudflare Workers preserve the 3xx status; browsers expose the Fetch-standard opaque redirect response.

When a `pfa_` agent token is configured, automatic agent-token refresh is on by default. An authenticated `401` calls `POST /v1/agent-tokens/refresh` through the raw Fetch layer and retries the original request once after a valid response. The retry preserves the serialized body, `Idempotency-Key`, and `Idempotency-Replay-Not-After`. A failed refresh or second `401` returns the original result. If the retry response is lost, the retry's transport error is returned because the request may have reached the server. Set `autoRefreshToken: false` to disable this policy.

Customer access tokens never trigger the agent refresh route. Use the generated public `refreshToken` operation for a customer access/refresh-token pair, persist its potentially rotated `refreshToken`, and expose the new `accessJwt` through a token callback. A lost or ambiguous customer refresh response must start a new device authorization because the refresh token can rotate.

Call `client.refreshAgentToken()` to refresh explicitly. The generated `refreshAgentToken({ client })` operation remains available.

If `token` is a callback that resolves to a `pfa_` token, the SDK resolves it for the original request and again for the retry. It validates the refresh response but does not replace or pin the callback's value. The credential-store owner remains authoritative. Concurrent `401` responses can each refresh because the token is never rotated and every refresh returns the same value.

## Protect financial mutations

Persist the exact body, confirmation intent ID, and idempotency key before a financial write. The SDK creates a key only for purchase quotes and `POST /v1/pay/{slug}` through `idempotencyKeyFactory`, and inside `payVendorSafely`, which owns one key per call and returns it on every data branch. Callers own the keys for transfers, purchases, and every other financial mutation, especially after a `submission_uncertain` result.

Purchase quotes and pay-per-use vendor payments are the exceptions. Configure `idempotencyKeyFactory` to supply a key when `createPurchaseQuote` or `payPerUsePayVendor` has no caller-provided `Idempotency-Key`:

```typescript
const agent_client = createPerfloClient({
  idempotencyKeyFactory: () => crypto.randomUUID(),
  token: "pfa_agent_pairing_token",
});
```

The factory runs only for `POST /v1/purchase-quotes` and `POST /v1/pay/{slug}` and must return a fresh value for every call; a constant would deduplicate distinct payments. It never overwrites a caller-provided key, and an automatic refresh retry reuses the first attempt's key. Supply the `Idempotency-Key` yourself, or use `payVendorSafely`, for a payment you may retry: a factory key is fresh for every request, so your own retry would start a second payment.

Use the exported helpers to decide whether replacement is safe:

```typescript
import {
  isDefinitiveNoOperation,
  isSubmissionUncertain,
} from "@perflo/finance-sdk";

if (isSubmissionUncertain(result.error)) {
  // Reconcile the existing operation. Do not create a replacement.
}
```

`isDefinitiveNoOperation(error)` returns `true` only when all four conditions hold:

- `status` is a `4xx` value other than `408`
- A valid, non-null problem document exists
- `submission_uncertain !== true`
- `problem.code` does not start with `idempotency_`

If a problem response sets `submission_uncertain` to `true`, stop replacement writes and reconcile the recorded operation. Read the [TypeScript SDK guide](https://docs.perflo.ai/developers/get-started/typescript-sdk) for the transfer flow and recovery rules. Use the [TypeScript SDK reference](https://docs.perflo.ai/developers/reference/typescript-sdk) for the complete client and generated operation surface.

## Poll purchases and operations

Use the resource-specific polling helpers when a caller needs the next purchase or operation boundary:

```typescript
import {
  type PurchaseView,
  isPollAbortedError,
  isPollDeadlineError,
  pollPurchaseUntilTerminal,
} from "@perflo/finance-sdk";

const cancellation = new AbortController();
const result = await pollPurchaseUntilTerminal({
  client,
  intervalMs: 2_000,
  purchaseId: "purchase_id",
  signal: cancellation.signal,
  timeoutMs: 120_000,
});

if (isPollDeadlineError<PurchaseView>(result.error)) {
  console.error(result.error.lastValue, result.error.outcomeMayStillChange);
} else if (isPollAbortedError<PurchaseView>(result.error)) {
  console.error("Polling was cancelled", result.error.reason);
}
```

`pollPurchaseUntilTerminal` calls `getPurchase` until the exhaustive `PURCHASE_STATUS_TERMINALITY` table classifies the status as terminal. `queued`, `running`, and `settling` continue; every other current purchase status stops. The package also exports the table and `isTerminalPurchaseStatus` so callers can apply the same classification without running the helper.

`pollOperationUntilActionable` calls `getOperation` until the operation needs caller attention or has reached a definitive state. It stops for `requires_action`, `indeterminate`, `succeeded`, `failed`, and `cancelled`. A submitted card withdrawal also stops, while every other submitted operation continues. The helper only reads the operation. It does not open a hosted action or invoke an approval or resolution mutation. Use `isActionableOperation` to apply this rule outside the polling helper.

Both wrappers use the exported `pollUntil<T>` engine and `PollFields<T>` result type. The engine polls immediately, never overlaps reads, waits `intervalMs` after each completed non-terminal read, and measures `timeoutMs` from invocation. Both values must be finite and positive. The caller owns the interval, timeout, and optional cancellation signal. The engine passes a linked child signal to every read so cancellation and the deadline stop interval sleep and in-flight Fetch work.

An ordinary read failure returns unchanged with its `request` and `response` fields. A deadline returns `PollDeadlineError<T>` with `code: "POLL_DEADLINE_EXCEEDED"`, the configured timeout, `outcomeMayStillChange: true`, and the last observed value when one exists. Caller cancellation returns `PollAbortedError<T>` with `code: "POLL_ABORTED"`, the caller's reason, and the last value when one exists. Use `isPollDeadlineError` and `isPollAbortedError` instead of `instanceof` so narrowing works across JavaScript realms. A deadline does not change or infer the resource's `submission_uncertain` field and never proves that a replacement write is safe.

## Pay a vendor safely

Use one call with bounded attempts when a pay-per-use payment may need a same-key replay or transaction recovery:

```typescript
const outcome = await payVendorSafely({
  client,
  slug,
  body: { input, query, subAccountId, maxCharge },
});
```

The data result is `settled`, `confirmation_required`, `recovered`, or `unknown`. `confirmation_required` means nothing has been charged yet and the payment is waiting on its second check; complete it with `payPerUseConfirmPayment` using `data.data.transactionId` and the instructions in `data.data.confirmation`. `settled` means the pay call returned a terminal payment view; inspect `data.data.status` and `chargeIsFinal`, because `failed`, `expired`, `canceled`, and `reversed` are terminal too. A recovered transaction carries money state only because a lost vendor response's output is not part of the transaction view. A recovered transaction is terminal but not necessarily successful; read `transaction.status` and `chargeIsFinal`.

Refused 4xx outcomes and a run exhausted entirely by undelivered retry-safe 503 responses are returned as ordinary error fields unless the call was aborted first, in which case the outcome is `PollAbortedError` and the refusal survives only as `response.status`; a refusal charges nothing unless its code reports a payment already in flight. The helper reads the transaction such a refusal names, so one that reaches you as an error field names none: reconcile it by reading recent transactions before paying again or, after one the helper had already identified, by reading that transaction; supply `idempotencyKey` yourself when you may need to reuse a key after a refusal, because a generated key is returned only on data results.

A response that carries no payment — a success that is not a payment, or a redirect — is replayed under the same key, or read when a transaction identifier is already known, and ends as `unknown` if it never resolves; unlike an undelivered response, it does not mean nothing was charged. When a successful status carried no payment or no transaction, `lastError` is the client's decode error or an `InvalidPaymentResponseError` whose `body` and `status` are what arrived; narrow it with `isInvalidPaymentResponseError`, while every other `unknown` keeps the last server envelope, transport error, deadline error, or non-terminal transaction view it saw.

The helper creates or accepts one `Idempotency-Key`, returns it on every data result, and never creates a second key during the call. The same key may be retried only with an identical body; a changed body or a new purchase needs a new key.

A caller abort returns `PollAbortedError` unless a terminal result had already landed — a `settled`, `confirmation_required`, or `recovered` result is returned even when the signal aborted in the same turn; narrow it with `isPollAbortedError` and read `lastValue` for the payment identifier when one was seen; the outcome also carries the last attempt's or read's `request` and `response` when one was made. The helper is bounded in attempts; with defaults, no server-supplied waits, and no `deadlineMs`, the worst-case wall time is about 227 seconds. A `Retry-After` on a `429` or a `poll.afterMs` on an open view can each add up to 60 seconds per replay; `deadlineMs` is the only caller-set overall wall-clock bound. Every same-key replay has to land inside the idempotency replay window that `GET /v1/identity` publishes as `idempotency_replay_window_seconds`; the helper's bounded wall time is designed to keep it there, and `deadlineMs` is the bound to lower when you need a tighter one.

## Check a verification URL

A `kyc_session` action carries an HTTPS URL to open in the customer's browser. `isAllowedVerificationUrl(value)` decides whether that URL is one a browser may be sent to, and it is the same rule the API enforces on a `kyc_session` action's `url`:

```typescript
import { isAllowedVerificationUrl } from "@perflo/finance-sdk";

if (!isAllowedVerificationUrl(action.url)) {
  // Send the customer to your own verification page instead.
}
```

It returns `true` for an HTTPS URL with no credentials and a host of at least two ASCII labels of letters, digits and inner hyphens, none of them `localhost` and none beginning `xn--`, each label at most 63 characters and the host at most 253, with one trailing dot allowed and a final label that is neither all digits nor `0x` hex. A zero or empty port, a percent sign or bracket in the authority, and a backslash, a space or an ASCII control character anywhere are refused. A non-string value returns `false`. Ownership, name resolution, and reachability are not checked.

## Update the contract

Replace `openapi.json` with the reviewed Perflo Finance contract and open a pull request. Continuous integration generates the client, compiles the public API, runs runtime and type tests, and validates the package tarball. Regenerate and check the SDK-owned method matrix in the sibling docs repository as described in the [contribution guide](https://github.com/perflo-ai/perflo-finance-sdk/blob/master/CONTRIBUTING.md); ordinary package builds never modify it automatically.

An explicit SemVer tag creates a GitHub Release. The release workflow derives the package version from the tag, regenerates the SDK, and attaches the validated tarball and checksum.
