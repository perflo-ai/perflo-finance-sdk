# Changelog

This changelog records user-visible changes to `@perflo/finance-sdk`.

## Unreleased

## 0.1.0-beta.15 - 2026-08-27

- Renamed the 23 pay-per-use operations from the `agent*` method family to the
  `payPerUse*` family: `agentListCapabilities` to
  `payPerUseListCapabilities`; `agentGetCapability` to
  `payPerUseGetCapability`; `agentSearchGet` to `payPerUseSearchVendors`;
  `agentSearch` to `payPerUseSearchVendorsWithBody`; `agentGetVendor` to
  `payPerUseGetVendor`; `agentPayVendor` to `payPerUsePayVendor`;
  `agentConfirmPayment` to `payPerUseConfirmPayment`; `agentGetAccount` to
  `payPerUseGetAccount`; `agentListSubAccounts` to
  `payPerUseListSubAccounts`; `agentCreateSubAccount` to
  `payPerUseCreateSubAccount`; `agentGetSubAccount` to
  `payPerUseGetSubAccount`; `agentUpdateSubAccount` to
  `payPerUseUpdateSubAccount`; `agentDisableSubAccount` to
  `payPerUseDisableSubAccount`; `agentDeleteSubAccounts` to
  `payPerUseRejectBulkSubAccountDeletion`; `agentGetOwnKey` to
  `payPerUseGetCallerAgentKey`; `agentListKeys` to
  `payPerUseListAgentKeys`; `agentCreateKey` to `payPerUseCreateAgentKey`;
  `agentRevokeKey` to `payPerUseRevokeAgentKey`; `agentCreateAccountKey` to
  `payPerUseCreateAccountKey`; `agentGetAccountKey` to
  `payPerUseGetAccountKey`; `agentRevokeAccountKey` to
  `payPerUseRevokeAccountKey`; `agentListResources` to
  `payPerUseListResources`; and `agentGetResource` to
  `payPerUseGetResource`. The five generated domains are now
  `Pay per use: discovery`, `Pay per use: payments`,
  `Pay per use: account and sub-accounts`, `Pay per use: keys`, and
  `Pay per use: resources`. The 73 `AgentMode*` types are now `PayPerUse*`.
  Success-envelope types end in `ResponseBody`, including
  `PayPerUseGetAccountResponseBody`. Stem-specific names are
  `PayPerUseGetCallerAgentKeyResponseBody`,
  `PayPerUseSearchVendorsResponseBody`,
  `PayPerUseSearchVendorsWithBodyRequest`,
  `PayPerUseSearchVendorsWithBodyResponseBody`,
  `PayPerUseCreateAgentKeyRequest`,
  `PayPerUseCreateAgentKeyResponseBody`,
  `PayPerUseRevokeAgentKeyResponseBody`,
  `PayPerUseListAgentKeysResponseBody`, and `PayPerUsePayVendorRequest`
  alongside the `PayPerUseRejectBulkSubAccountDeletionData`,
  `PayPerUseRejectBulkSubAccountDeletionError`, and
  `PayPerUseRejectBulkSubAccountDeletionErrors` family (breaking)
- Added `payPerUseListTransactions` and `payPerUseGetTransaction` for
  `GET /v1/transactions` and `GET /v1/transactions/{id}`, with
  `PayPerUseTransactionView`, `PayPerUseSignedMoney`,
  `PayPerUseListTransactionsListMeta`,
  `PayPerUseListTransactionsResponseBody`, and
  `PayPerUseGetTransactionResponseBody` (additive)
- Added `payVendorSafely`, `PayVendorSafelyOptions`, `PayVendorOutcome`, and
  `PayVendorResult`: one single-key payment call with bounded attempts that
  replays the same
  `Idempotency-Key` on an open payment (`indeterminate`, `queued`, or
  `running`), on `SERVICE_UNAVAILABLE` with `retrySafe: true`, on
  `OPERATION_OUTCOME_UNKNOWN` and other 5xx or 429 answers, on a transport
  failure or attempt timeout, and on a successful or redirect status that
  carries no payment; reads when a transaction identifier is already known,
  including one named by an error envelope, until the transaction is terminal;
  and returns `settled`, `confirmation_required`, `recovered`, or `unknown`,
  with refusals and exhausted undelivered 503s as ordinary error fields
  (additive)
- Added `InvalidPaymentResponseError` and
  `isInvalidPaymentResponseError`. When a successful status carried no payment
  or no transaction, `lastError` is the client's decode error or an
  `InvalidPaymentResponseError` whose `body` and `status` are what arrived;
  every other `unknown` keeps the last server envelope, transport error,
  deadline error, or non-terminal transaction view it saw (additive)
- `idempotencyKeyFactory` now also supplies a key to `payPerUsePayVendor`
  (`POST /v1/pay/{slug}`) when the caller sends none. A factory configured for
  purchase quotes stamps pay calls too and must return a fresh value for every
  call; a caller-provided `Idempotency-Key` still wins. Supply the
  `Idempotency-Key` yourself, or use `payVendorSafely`, for a payment you may
  retry: a factory key is fresh for every request, so your own retry would start
  a second payment (breaking)

## 0.1.0-beta.14 - 2026-08-26

- Added 23 agent-mode operations across the generated `Agent discovery`,
  `Agent payments`, `Agent account`, `Agent keys`, and `Agent resources` domains,
  including `agentListCapabilities`, `agentPayVendor`, `agentCreateSubAccount`,
  `agentCreateKey`, and `agentListResources` (additive)
- Added `createAccount` for confirmed idempotent fiat account provisioning and
  `accountEndorsement` for the restricted endorsement projection. Account
  provisioning returns a tracked operation. Read-only reconciliation requires
  exactly one account in the requested currency and never repeats an uncertain
  write. Check `account_provisioning` before `createAccount`; `accounts` gates
  account listing and endorsement. The endorsement read returns only `currency`,
  `in_progress`, and nullable open `phase` (additive)
- Added `account.create` to `ConfirmationIntentCreate.action` and
  `account_create` to `OperationView.kind`, and added the required
  `account_provisioning` capability. Exhaustive consumers of the closed unions
  and exhaustive `keyof PerfloCapabilitiesView` consumers or callers constructing
  complete capability objects must handle the new members (breaking)

## 0.1.0-beta.13 - 2026-08-24

- Added `PURCHASE_STATUS_TERMINALITY`, `isTerminalPurchaseStatus`,
  `isActionableOperation`, `pollUntil`, `pollPurchaseUntilTerminal`, and
  `pollOperationUntilActionable`. The read-only wrappers poll immediately,
  never overlap reads, preserve field-style results, and pass caller
  cancellation and deadlines through in-flight reads and automatic agent-token
  refresh. `PollDeadlineError` and `PollAbortedError` keep control outcomes
  distinct and retain the last observed resource when one exists. Submitted
  card withdrawals are actionable; every other submitted operation continues
  (additive)

## 0.1.0-beta.12 - 2026-08-24

- Added `createCardWithdrawal` for `POST /v1/card-account/withdrawals`.
  It takes the customer card ID, a United States dollar amount, and an asset
  from the deposit address's `accepted_assets`. The amount must be exactly
  representable in whole cents and must be no more than `9007199254740991`
  cents. How it is spelled does not change what is accepted. Repeat the same
  amount spelling under the same idempotency key. The exponent spelling
  `1.025E+1` canonicalizes to plain `10.25`, while the trailing-zero spelling
  `10.250` remains distinct from `10.25`. It uses the new
  `card_withdrawal.create` confirmation action and `card_withdrawal` operation
  kind. A definitively accepted operation rests at `submitted` and carries the
  withdrawal ID as `external_reference`; use `cardWithdrawals` to read its
  status, transaction hash, and completion. The route answers `202` whether or
  not card withdrawals are available: when they are not, the operation reaches
  `failed` with `failure_code: "card_withdrawal_unavailable"`, a definitive
  refusal. Branch on `failure_code`, not on the response status (additive)
- Amount strings are spelled the same way everywhere, on every operation that
  carries one, including operations that existed before. An amount is written
  out in full rather than in exponent notation, so `1E-7` reads as `0.0000001`.
  An amount answered from a stored record — a mandate cap, a remaining
  allowance, a card balance, a purchase price, a withdrawal amount — reads at
  its own scale, with the places the record adds dropped, so
  `12.500000000000000000` reads as `12.5`; an amount Perflo states in the same
  request keeps the digits it was stated with, so `12.50` stays `12.50`. The
  one exception is a spelling long enough to be padding rather than an amount:
  writing an amount out in full is bounded, so a value carrying more redundant
  zeros than that bound admits reads at its own scale instead. The bound is
  wide enough that no amount inside the published limit reaches it. A
  serialized amount string on an existing operation can therefore change byte
  for byte. The values are unchanged; parse them as decimals and nothing moves.
  That published limit binds on what you send as well: an amount carries at
  most 20 digits before the decimal point and at most 18 after it — 38 in total
  at the full-scale corner — and one carrying more is refused with `422` rather
  than accepted and rounded when it is stored. The limit counts the value
  rather than the spelling it is written in, so redundant trailing zeros carry
  nothing and are ignored: `1.000000000000000000000` is one digit and no
  decimal places (breaking)
- Added synchronous card-account operations for reading one card, changing or
  clearing its private label, reading the card profile and KYC state, starting a
  hosted KYC session, reading the deposit address, and listing deposits and
  withdrawals. `cardWithdrawals` answers a bare array; `cardDeposits` answers an
  object carrying the rows, their credited total, and the `card_id` they belong
  to. The deposit address states its primary asset as `asset` and is returned in
  full only to the linked customer. Deposit and withdrawal statuses remain open
  strings, and the optional `card_id` query on the three scoped reads takes 1 to
  36 characters (additive)
- `createCard` trims the private label and bounds it at 80 characters after the
  trim; a blank label becomes null. This changes an operation that already
  existed: the label stored for a request carrying surrounding spaces, or a
  label of nothing but spaces, is no longer what was sent, and the idempotency
  and confirmation hashes taken over the body move with it, so two spellings
  that used to replay as two requests now replay as one (breaking)
- Renamed `BeneficiaryCountry` to `BeneficiaryCountryView` and bound its country
  code to two uppercase ASCII letters and its display name to a non-empty value
  (breaking)
- `BeneficiaryCreate.country`, `BeneficiaryCreate.currency`, and the `country`
  query parameter of `beneficiarySchemas` now require ASCII letters: a two- or
  three-character value that is not ASCII-alphabetic is refused with `422`
  (breaking)
- `POST /v1/mandates/{mandate_id}/executions` now reports a mandate from a
  previous Perflo connection as `409 perflo_connection_superseded` instead of
  `403 forbidden` (breaking)
- Added `beneficiaryAddressCountries`, `beneficiaryByNickname`, and
  `renameBeneficiary` for the synchronous beneficiary metadata routes. Rename
  trims the label, accepts `null` or blank input to clear it, and reports
  `beneficiary_nickname_taken` when the label is already carried by another
  beneficiary (additive)
- Hosted KYC actions can carry the customer-specific HTTPS URL Perflo states.
  The URL check requires a URL with no credentials and a host of at least
  two ASCII labels of letters, digits and inner hyphens, none of them
  `localhost`, none beginning `xn--`, and a final label that is neither all
  digits nor `0x` hex; it does not verify ownership, name resolution, or
  reachability (additive)
- `isAllowedVerificationUrl` is exported: the verification-URL rule the API
  enforces, tested against `verification-url-corpus.json` (additive)
- `POST /v1/beneficiaries` and `PATCH /v1/beneficiaries/{beneficiary_id}` bound
  `nickname` at 80 characters after trimming (additive)
- Added `revokeBeneficiaryGrant` for
  `POST /v1/mandates/beneficiary-grants/{grant_id}/revoke`, which ends one
  automatic-payment grant held directly on the customer's Perflo account and
  answers with the operation that tracks it. It takes the new confirmation
  action `beneficiary_grant.revoke` over `{"grant_id":"grant_id"}` and produces
  the new operation kind `beneficiary_grant_revoke` (additive)
- Added `revokeAllMandates` for `POST /v1/mandates/revoke-all`, which stops every
  agent's authority on the account in one call: it revokes every active pairing
  and opens one mandate revocation for each mandate that still holds authority.
  It takes the new confirmation action `mandate.revoke_all` over `{}`, produces
  the new operation kind `mandate_revoke_all`, and answers with the new
  `MandateRevocationBatchView` carrying the batch, one operation per revocation,
  and the revoked pairing identifiers (additive)

## 0.1.0-beta.11 - 2026-08-19

- Renamed the grant surface so it uses the same word as the rest of the API:
  `mandateProviderGrants` and `spendProviderGrant` are now
  `mandateBeneficiaryGrants` and `spendBeneficiaryGrant`; `ProviderGrantView`
  and `ProviderGrantPaymentCreate` are now `BeneficiaryGrantView` and
  `BeneficiaryGrantPaymentCreate`; the routes moved from
  `/v1/mandates/provider-grants` to `/v1/mandates/beneficiary-grants`. The
  confirmation action `provider_grant.spend` and the operation kind
  `provider_grant_payment` moved with them (breaking)
- Renamed `OperationView.upstream_reference` to `external_reference` (breaking)
- `PurchaseView.price_cap_enforcement` now reads `at_charge` or `preflight`
  instead of `upstream` or `local`, naming when the cap binds rather than which
  layer applied it (breaking)
- Renamed sixteen problem codes, which reach a client as `code` on a problem
  document and as `OperationView.failure_code` (breaking):
  `provider_authorization_required` to `account_authorization_required`;
  `provider_grant_destination_mismatch`, `provider_grant_inactive`,
  `provider_grant_exhausted`, `provider_grant_amount_exceeded` and
  `provider_grant_context_invalid` to their `beneficiary_grant_*` equivalents;
  `beneficiary_provider_context_missing`, `_invalid` and `_unavailable` to
  `beneficiary_context_missing`, `_invalid` and `_unavailable`;
  `provider_connection_changed` to `perflo_connection_superseded`, which is a NEW
  code rather than the pre-existing `perflo_connection_changed`: the two describe
  different situations, and only the latter sets `refresh_onboarding`;
  `provider_transport_error` to `perflo_transport_error`;
  `provider_evidence_collision` to `evidence_collision`;
  `provider_dispatch_failed` to `dispatch_failed`;
  `provider_transaction_failed` to `transaction_failed`;
  `mandate_provider_mismatch` to `mandate_grant_mismatch`; and
  `identity_provider_unavailable` to `signin_verification_unavailable`
- Removed `operator_action_required` from `PerfloConnectionView.status` and
  `OnboardingView.perflo_connection`. A link needing attention reads
  `reconnect_required`, and one with nothing to reconnect to reads
  `not_connected` (breaking)
- Renamed the live-exercise environment variable
  `PERFLO_LIVE_PROVIDER_GRANT_PAYMENT` to
  `PERFLO_LIVE_BENEFICIARY_GRANT_PAYMENT`

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
