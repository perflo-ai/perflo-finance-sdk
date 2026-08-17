# Changelog

This changelog records user-visible changes to `@perflo/finance-sdk`.

## Unreleased

## 0.1.0-beta.10 - 2026-08-18

- Renamed the response fields that publish a customer's own account number,
  IBAN, beneficiary or grant destination, and linked-account identifier in
  full: `BankDetails.account_number_masked` and `iban_masked`
  are now `account_number` and `iban`; `BeneficiaryView.destination_masked` and
  `ProviderGrantView.destination_masked` are now `destination`;
  `PerfloConnectionView.account_hint` and `OnboardingView.perflo_account_hint`
  are now `account_identifier` and `perflo_account_identifier`. Values are
  unchanged; the old names are gone (breaking type change)
- Added `startSign` and `pollSign` for the relayed Perflo CLI signing
  endpoints
- Added a production API exercise for customer device authorization, Perflo
  connection, capability-gated reads, quotes, webhooks, and opt-in journaled
  mutations
- Updated the generated documentation for the bank identifier, beneficiary
  destination and linked-account fields, which state that they publish in full,
  and for the Perflo connection states, which no longer describe a terminal
  operator-action state
- Documented that disconnecting a Perflo connection erases the stored
  credential but keeps the account's authority, so mandates, agent pairings,
  beneficiaries, cards, quotes and webhook subscriptions survive it; revoke a
  beneficiary-payment mandate before disconnecting, because revoking one needs
  the credential the disconnect erases
- Documented that the device and signing session identifier returned by the
  start operations is itself the capability for the matching poll operation and
  must be handled as a short-lived bearer secret

## 0.1.0-beta.9 - 2026-08-14

- Typed non-throwing operation errors as `unknown` to cover HTTP bodies, decode
  failures, request-construction failures, and Fetch failures honestly
- Added `isProblemDetails` for narrowing errors before reading problem fields
- Documented that throw mode raises raw decode errors without attaching the
  HTTP response

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
