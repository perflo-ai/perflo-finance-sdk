# Perflo Finance TypeScript SDK

Use `@perflo/finance-sdk` from a Node.js backend to call the Perflo Finance API with generated operations and types. Preview releases are available as validated GitHub Release tarballs before the package moves to the npm registry.

## Install a preview release

Set the release location once in your shell:

```bash
sdk_version="v0.1.0-beta.1"
sdk_archive="perflo-finance-sdk-0.1.0-beta.1.tgz"
sdk_releases="https://github.com/perflo-ai/perflo-finance-sdk/releases"
```

Install the tarball with pnpm or npm:

```bash
pnpm add "$sdk_releases/download/$sdk_version/$sdk_archive"
# or
npm install "$sdk_releases/download/$sdk_version/$sdk_archive"
```

Node.js 22.18 or later is required. The package is an ECMAScript module (ESM) and has no runtime dependencies.

## Create a client

Create one client for each customer or agent credential:

```typescript
import {
  createPerfloClient,
  getIdentity,
} from "@perflo/finance-sdk";

const client = createPerfloClient({
  token: "customer_access_jwt",
});

const { data, error, response } = await getIdentity({ client });
```

HTTP failures return through `error` and `response`. A network or Fetch failure returns through `error` without a response. The client rejects redirects and never retries a request.

## Protect financial mutations

Persist the exact body, confirmation intent ID, and idempotency key before a financial write. The SDK does not create these controls, retry requests, refresh tokens, or reconcile uncertain submissions.

If a problem response sets `submission_uncertain` to `true`, stop replacement writes and reconcile the recorded operation. Read the [TypeScript SDK guide](https://apidocs.perflo.ai/get-started/typescript-sdk) for the transfer flow and recovery rules.

## Update the contract

Replace `openapi.json` with the reviewed Perflo Finance contract and open a pull request. Continuous integration generates the client, compiles the public API, runs runtime and type tests, and validates the package tarball.

An explicit SemVer tag creates a GitHub Release. The release workflow derives the package version from the tag, regenerates the SDK, and attaches the validated tarball and checksum.
