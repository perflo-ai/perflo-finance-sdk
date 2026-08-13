# Changelog

This changelog records user-visible changes to `@perflo/finance-sdk`.

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
