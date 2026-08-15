# Perflo Finance TypeScript SDK

Use `@perflo/finance-sdk` from Node.js, browsers, or Cloudflare Workers to call the Perflo Finance API with generated operations and types. Preview releases are available as validated GitHub Release tarballs before the package moves to the npm registry.

## Install a preview release

Set the release location once in your shell:

```bash
sdk_version="v0.1.0-beta.9"
sdk_archive="perflo-finance-sdk-0.1.0-beta.9.tgz"
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

If `token` is a callback that resolves to a `pfa_` token, the SDK resolves it for the original request and again for the retry. It validates the refresh response but does not replace or pin the callback's value. The credential-store owner remains authoritative. Concurrent `401` responses can each refresh because the gateway re-stamp is idempotent and returns the same token value.

## Protect financial mutations

Persist the exact body, confirmation intent ID, and idempotency key before a financial write. The SDK never creates keys for purchases, transfers, or other financial mutations. Callers own those keys, especially after a `submission_uncertain` result.

Purchase quotes are the only exception. Configure `idempotencyKeyFactory` to supply a key when `createPurchaseQuote` has no caller-provided `Idempotency-Key`:

```typescript
const agent_client = createPerfloClient({
  idempotencyKeyFactory: () => crypto.randomUUID(),
  token: "pfa_agent_pairing_token",
});
```

The factory runs only for `POST /v1/purchase-quotes`. It never overwrites a caller-provided quote key, and an automatic refresh retry reuses the first attempt's key.

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

## Update the contract

Replace `openapi.json` with the reviewed Perflo Finance contract and open a pull request. Continuous integration generates the client, compiles the public API, runs runtime and type tests, and validates the package tarball. Regenerate and check the SDK-owned method matrix in the sibling docs repository as described in the [contribution guide](https://github.com/perflo-ai/perflo-finance-sdk/blob/master/CONTRIBUTING.md); ordinary package builds never modify it automatically.

An explicit SemVer tag creates a GitHub Release. The release workflow derives the package version from the tag, regenerates the SDK, and attaches the validated tarball and checksum.
