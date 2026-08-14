# Changelog

This changelog records user-visible changes to `@perflo/finance-sdk`.

## 0.1.0-beta.8 - 2026-08-14

- Enforced declared JSON decoding for every generated operation
- Returned empty or malformed non-204 successful responses as decode errors
  with their HTTP response instead of fabricated successful data
- Preserved `204` as undefined data and JSON `null` as null data

## 0.1.0-beta.7 - 2026-08-14

- Made generated operation results type-safe by enforcing field-style responses
  after caller options
- Prevented shared response and error configuration from invalidating generated
  operation and explicit refresh return types
- Added the complete generated TypeScript SDK method-reference tooling

## 0.1.0-beta.6 - 2026-08-14

- Fixed authenticated requests in Cloudflare Workers by using the portable
  manual redirect mode
- Continued to prevent redirects from being followed while returning them as
  non-ok results
- Added a built-package workerd smoke covering authenticated dispatch,
  credential omission, and redirect handling

## 0.1.0-beta.5 - 2026-08-14

- Added explicit and automatic refresh for mandate-scoped agent tokens
- Added `isSubmissionUncertain` and `isDefinitiveNoOperation` recovery helpers

## 0.1.0-beta.4 - 2026-08-14

- Enforced origin, authentication, Fetch, credential, and redirect policies at
  final request dispatch
- Prevented request interceptors, client configuration, and operation options
  from redirecting bearer-authenticated requests to another origin

## 0.1.0-beta.3 - 2026-08-14

- Added a portable SHA-256 checksum manifest to preview releases

## 0.1.0-beta.2 - 2026-08-14

- Rebuilt the preview with the patched SDK generator dependency chain

## 0.1.0-beta.1 - 2026-08-14

- Added all generated Perflo Finance API operations and public contract types
- Added isolated customer and agent clients with request-time authentication
- Added fixed-origin, credential-omission, and redirect-rejection policies
- Added field-style success and error results without automatic retries
