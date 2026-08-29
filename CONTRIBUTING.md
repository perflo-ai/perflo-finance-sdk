# Contribute to the TypeScript SDK

Use this guide to update the public contract, validate the generated SDK, and create a preview release.

## Prepare the repository

Install Node.js 22.18 or later and enable pnpm 11.5.2 through Corepack. The project enforces a seven-day dependency release-age gate.

Install the locked dependencies:

```bash
pnpm install --frozen-lockfile
```

## Update the API contract

Replace `openapi.json` with the reviewed contract from the canonical API repository. Do not edit generated files because the repository ignores `src/generated` and `dist`.

`pnpm run generate` runs `openapi-ts`, then three repository scripts that post-process `src/generated`. `patch-cli-error-unions.mjs` widens error unions that the generator cannot express, and `patch-sdk-result-contract.mjs` enforces the JSON-fields result contract. `generate-auth-policy.mjs` writes the generated authentication policy table.

`patch-sdk-result-contract.mjs` and `generate-sdk-reference.mjs` perform bidirectional route checks between OpenAPI and `src/generated/sdk.gen.ts`. `patch-cli-error-unions.mjs` looks up a route only when an error response publishes more than one media type. All three scripts share `scripts/lib/generated-operations.mjs` as the single model of the generated operation shape. When you bump the exact `@hey-api/openapi-ts` pin, regenerate the SDK and run the reference check:

```bash
pnpm run generate
pnpm run docs:reference -- \
  --check ../perflo-docs/developers/reference/typescript-sdk.mdx
```

`scripts/lib/generator-naming.mjs` is the single audit target for the pinned naming rules it models. Check `operationToId` and `applyNaming` against the `@hey-api/sdk` `operations.methodName` default and `reserved.runtime`, and check `applyNaming` against the `@hey-api/typescript` `definitions` default and `reserved.type`. Also check the `safeName` start and continuation rules. The scripts read operation sibling type names from the emitted artifacts instead of deriving them because those names originate from `operation.id`, an intermediate representation identifier that this module deliberately does not model.

Every test run checks operation naming against all 102 real operation IDs and generated declaration names. It also runs the pinned generator on operation IDs with adjacent single-letter segments and compares every operation name consumed by the scripts with `sdk.gen.ts` and `types.gen.ts`. Do not accept a pinned naming claim without an end-to-end generator run over inputs from the affected adversarial class. Source inspection, reconstructed naming steps, and comparisons between candidate derivations do not establish the emitted name.

A byte-identical `src/generated` tree does not exercise component-schema naming because the shipped schema keys are plain PascalCase identifiers. It also does not prove sibling type naming for adjacent single-letter operation ID segments because no shipped operation ID belongs to that adversarial class.

All four scripts reject path-item `$ref` shapes as producer-change tripwires. Only `patch-cli-error-unions.mjs` walks response objects and rejects response `$ref` shapes; the other three scripts do not validate them. The exporter calls the gateway’s customized `app.openapi()`, whose hand-maintained agent-mode overlay rejects path-item references but does not forbid response references. If response references must remain structurally impossible, enforce that invariant in the overlay validator rather than attributing it to FastAPI.

If the producer starts emitting either reference shape, do not add separate resolvers to the scripts. Dereference the document once at the top of the pipeline with a mature library and write the resolved document once. Set `PERFLO_SDK_OPENAPI` to the resolved file for all four scripts. If the two pinned naming descriptors diverge again, replace them with an in-memory generator dry-run keyed by route instead of adding another mirrored configuration.

If a contract needs nested operation IDs containing `.` or `/`, replace the refusal with `OperationPath.fromOperationId` or an in-memory generator dry run keyed by route. Do not transcribe the generator’s split-and-rejoin normalization.

When `perflo-docs` is checked out beside this repository, regenerate the SDK first, then update only the generated region of its TypeScript SDK reference:

```bash
pnpm run generate
pnpm run docs:reference -- \
  --write ../perflo-docs/developers/reference/typescript-sdk.mdx
pnpm run docs:reference -- \
  --check ../perflo-docs/developers/reference/typescript-sdk.mdx
```

The explicit page path is required. The SDK command never modifies a sibling repository during a normal build. Commit the regenerated reference in the paired docs pull request.

Run the complete package check and repeat the real-page reference check before opening the SDK pull request:

```bash
pnpm run ci
pnpm run docs:reference -- \
  --check ../perflo-docs/developers/reference/typescript-sdk.mdx
```

Open a pull request that describes contract additions, removals, and generated TypeScript breaking changes.

## Create a release

Choose the SemVer version after reviewing the generated public API. Operation name changes, removed fields, and stricter required inputs require a breaking version change.

Create and push an annotated tag:

```bash
git tag -a v0.1.0-beta.1 -m "Release v0.1.0-beta.1"
git push origin v0.1.0-beta.1
```

The release workflow derives the package version from the tag, runs all checks, and attaches the package tarball and SHA-256 checksum to a GitHub Release.
