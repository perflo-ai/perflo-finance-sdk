import {
  type AccountView,
  type CliDevicePollResponse,
  type CliErrorResponse,
  type CreateMandateData,
  type CreateTransferData,
  closeCard,
  createKycSession,
  createPerfloClient,
  createTransfer,
  type DevicesError,
  type IdentityView,
  type Money,
  type PollDeviceError,
  type ProblemDetails,
  type PurchaseCreate,
  type RefreshTokenError,
  type ResolveOperationApprovalData,
  type RevokeTokenError,
  type StartDeviceError,
  startPerfloConnection,
} from "@perflo/finance-sdk";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;
type IsRequired<Value, Key extends keyof Value> =
  object extends Pick<Value, Key> ? false : true;

export type MoneyAmountsStayStrings = Assert<Equal<Money["amount"], string>>;
export type DateTimesStayStrings = Assert<
  Equal<AccountView["observed_at"], string>
>;
export type ClientIdStaysRequiredNullable = Assert<
  Equal<IdentityView["client_id"], string | null>
>;
export type ClientIdCannotBeOmitted = Assert<
  IsRequired<IdentityView, "client_id">
>;
export type WalletCannotBeOmitted = Assert<IsRequired<IdentityView, "wallet">>;
export type ConfirmationHeaderIsRequired = Assert<
  IsRequired<CreateTransferData["headers"], "Confirmation-Intent-ID">
>;
export type IdempotencyHeaderIsRequired = Assert<
  IsRequired<CreateTransferData["headers"], "Idempotency-Key">
>;
type CliErrorUnion = CliErrorResponse | ProblemDetails;
export type PollDeviceKeepsBothErrorMediaTypes = Assert<
  Equal<PollDeviceError, CliErrorUnion>
>;
export type StartDeviceKeepsBothErrorMediaTypes = Assert<
  Equal<StartDeviceError, CliErrorUnion>
>;
export type DevicesKeepsBothErrorMediaTypes = Assert<
  Equal<DevicesError, CliErrorUnion>
>;
export type RefreshTokenKeepsBothErrorMediaTypes = Assert<
  Equal<RefreshTokenError, CliErrorUnion>
>;
export type RevokeTokenKeepsBothErrorMediaTypes = Assert<
  Equal<RevokeTokenError, CliErrorUnion>
>;

export function narrowMandate(body: CreateMandateData["body"]): string {
  switch (body.kind) {
    case "beneficiary_payment":
      return body.beneficiary_id;
    case "service_purchase":
      return body.allowed_services?.join(",") ?? "all";
  }

  const exhaustive: never = body;
  return exhaustive;
}

export function narrowPurchase(target: PurchaseCreate["target"]): string {
  switch (target.kind) {
    case "query":
      return target.query;
    case "service":
      return target.service_id;
    case "endpoint":
      return `${target.method} ${target.url}`;
  }

  const exhaustive: never = target;
  return exhaustive;
}

export function narrowApproval(
  body: ResolveOperationApprovalData["body"],
): string | undefined {
  switch (body.attestation) {
    case "grant_created":
      return body.grant_id ?? undefined;
    case "no_grant_created":
      return body.attestation;
  }

  const exhaustive: never = body;
  return exhaustive;
}

export function narrowDevicePoll(response: CliDevicePollResponse): string {
  if (!response.data) {
    return "missing";
  }
  switch (response.data.status) {
    case "complete":
      return response.data.result.refreshToken;
    case "denied":
    case "expired":
    case "pending":
      return response.data.status;
  }

  const exhaustive: never = response.data;
  return exhaustive;
}

const client = createPerfloClient();

export const createKycWithoutBody = createKycSession({ client });
export const connectWithoutBody = startPerfloConnection({ client });
export const closeCardWithoutBody = closeCard({
  client,
  headers: {
    "Confirmation-Intent-ID": "confirmation_intent_id",
    "Idempotency-Key": "idempotency_key",
  },
  path: { card_id: "card_id" },
});

// @ts-expect-error Money amounts are never JSON numbers.
export const invalidMoney: Money = { amount: 1, currency: "USD" };

// @ts-expect-error Required-nullable fields cannot be omitted.
export const identityWithoutClientId: IdentityView = {
  actor_type: "customer",
  idempotency_replay_window_seconds: 86_400,
  scopes: [],
  server_time: "2026-08-13T00:00:00Z",
  subject: "customer_subject",
  wallet: null,
};

// @ts-expect-error Financial writes require both control headers.
export const transferWithoutHeaders = createTransfer({
  body: { quote_id: "transfer_quote" },
  client,
});
