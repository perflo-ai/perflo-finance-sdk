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

Run the complete package check:

```bash
pnpm run ci
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
