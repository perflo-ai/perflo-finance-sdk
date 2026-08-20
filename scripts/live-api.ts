import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import {
  type FileHandle,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  accounts,
  activity,
  type BeneficiaryCountry,
  type BeneficiaryCreate,
  type BeneficiaryGrantPaymentCreate,
  beneficiaries,
  beneficiaryCountries,
  beneficiarySchemas,
  type CardCreate,
  type CliDeviceCredentials,
  type ConfirmationIntentCreate,
  type CreateMandateData,
  cardRevealSession,
  cards,
  cardTransactions,
  createBeneficiary,
  createCard,
  createConfirmationIntent,
  createKycSession,
  createMandate,
  createPerfloClient,
  createPurchase,
  createPurchaseQuote,
  createQuote,
  createSpendingWithdrawal,
  createSubscription,
  createTransfer,
  deleteSubscription,
  devices,
  displayCurrency,
  executeMandate,
  freezeCard,
  getBeneficiary,
  getIdentity,
  getMandate,
  getOperation,
  getPurchase,
  getService,
  getSpendingWithdrawal,
  isDefinitiveNoOperation,
  kycStatus,
  listActivity,
  listOperations,
  listServices,
  listSubscriptions,
  type MandateExecutionCreate,
  mandateBeneficiaryGrants,
  mandates,
  type OnboardingView,
  type OperationView,
  onboarding,
  PERFLO_API_ORIGIN,
  type PerfloClient,
  type PurchaseCreate,
  pollDevice,
  pollOperationApproval,
  pollPerfloConnection,
  publicConfig,
  purchases,
  type QuoteCreate,
  type ServiceView,
  type SpendingWithdrawalCreate,
  serviceCapabilities,
  services,
  spendBeneficiaryGrant,
  spendingAccount,
  startDevice,
  startPerfloConnection,
  unfreezeCard,
} from "@perflo/finance-sdk";

const TRUSTED_APP_ORIGIN = "https://app.perflo.ai";
const DEFAULT_CONNECTION_TIMEOUT_MS = 180_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 180_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_READ_DELAY_MS = 500;
const DEFAULT_JOURNAL_PATH = ".perflo-live-api-state.json";

function mutationResourceId(action: string, resourceId: string | undefined) {
  if (!resourceId) {
    throw new TypeError(`${action} requires a resource ID`);
  }
  return encodeURIComponent(resourceId);
}

const MUTATION_CONTRACTS = {
  "beneficiary.create": {
    operationKind: "beneficiary_create",
    path: () => "/v1/beneficiaries",
  },
  "card.create": {
    operationKind: "card_create",
    path: () => "/v1/cards",
  },
  "card.freeze": {
    operationKind: "card_freeze",
    path: (resourceId?: string) =>
      `/v1/cards/${mutationResourceId("card.freeze", resourceId)}/freeze`,
  },
  "card.unfreeze": {
    operationKind: "card_unfreeze",
    path: (resourceId?: string) =>
      `/v1/cards/${mutationResourceId("card.unfreeze", resourceId)}/unfreeze`,
  },
  "mandate.create": {
    operationKind: "mandate_create",
    path: () => "/v1/mandates",
  },
  "mandate.execute": {
    operationKind: "mandate_transfer",
    path: (resourceId?: string) =>
      `/v1/mandates/${mutationResourceId("mandate.execute", resourceId)}/executions`,
  },
  "beneficiary_grant.spend": {
    operationKind: "beneficiary_grant_payment",
    path: (resourceId?: string) =>
      `/v1/mandates/beneficiary-grants/${mutationResourceId("beneficiary_grant.spend", resourceId)}/payments`,
  },
  "purchase.create": {
    operationKind: "service_purchase",
    path: () => "/v1/purchases",
  },
  "spending_withdrawal.create": {
    operationKind: "spending_withdrawal",
    path: () => "/v1/spending-withdrawals",
  },
  "transfer.create": {
    operationKind: "transfer",
    path: () => "/v1/transfers",
  },
} as const satisfies Record<
  string,
  {
    operationKind: OperationView["kind"];
    path: (resourceId?: string) => string;
  }
>;

type MutationAction = keyof typeof MUTATION_CONTRACTS;

type CheckState = "PASS" | "FAIL" | "SKIP";

type SdkResult<T> = {
  data?: T;
  error?: unknown;
  response?: Response;
};

type ResultValidator<T> = (data: T) => string | undefined;

type JournalStatus =
  | "planned"
  | "confirmed"
  | "submitted"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rejected"
  | "unresolved"
  | "indeterminate";

type JournalEntry = {
  action: MutationAction;
  body: unknown;
  confirmation_payload?: Record<string, unknown>;
  confirmation_intent_id?: string;
  created_at: string;
  id: string;
  idempotency_key: string;
  method: "POST";
  operation_id?: string;
  path: string;
  response_operation_id?: string;
  status: JournalStatus;
  submission_started_at?: string;
  updated_at: string;
};

type Journal = {
  context: JournalContext;
  entries: Array<JournalEntry>;
  version: 2;
};

type JournalContext = {
  api_origin: string;
  customer_id: string;
  subject: string;
};

type ReadContext = {
  services?: Array<ServiceView>;
};

type CardActionScenario = {
  action: "freeze" | "unfreeze";
  card_id: string;
};

type MandateExecutionScenario = {
  body: MandateExecutionCreate;
  mandate_id: string;
};

type BeneficiaryGrantScenario = {
  body: BeneficiaryGrantPaymentCreate;
  grant_id: string;
};

type MutationFixtures = {
  beneficiary?: BeneficiaryCreate;
  cardAction?: CardActionScenario;
  cardCreate?: CardCreate;
  mandate?: CreateMandateData["body"];
  mandateExecution?: MandateExecutionScenario;
  beneficiaryGrant?: BeneficiaryGrantScenario;
  purchase?: PurchaseCreate;
  revealCardId?: string;
  transfer?: QuoteCreate;
  withdrawal?: SpendingWithdrawalCreate;
};

type LiveConfig = {
  connectionTimeoutMs: number;
  mutations: MutationFixtures;
  operationTimeoutMs: number;
  reconciliation: ReconciliationConfig;
  transferQuote?: QuoteCreate;
  webhookUrl?: string;
};

type ReconciliationConfig =
  | { kind: "none" }
  | { entryId: string; kind: "operation"; operationId: string }
  | { entryId: string; kind: "no_operation" };

type MutationDispatch = {
  idempotencyKey: string;
  signal: AbortSignal;
};

type JournaledMutationBase = {
  body: unknown;
  client: PerfloClient;
  confirm?: typeof requirePhrase;
  journal: Journal;
  journalPath: string;
  label: string;
  operationTimeoutMs: number;
  path: string;
};

type JournaledMutationOptions =
  | (JournaledMutationBase & {
      action: Exclude<MutationAction, "beneficiary.create">;
      confirmationPayload: Record<string, unknown>;
      customerToken: string;
      send: (
        dispatch: MutationDispatch & { confirmationIntentId: string },
      ) => PromiseLike<SdkResult<OperationView>>;
    })
  | (JournaledMutationBase & {
      action: "beneficiary.create";
      confirmationPayload?: never;
      customerToken?: never;
      send: (
        dispatch: MutationDispatch,
      ) => PromiseLike<SdkResult<OperationView>>;
    });

type ValidDeviceCredentials = CliDeviceCredentials & {
  accessJwt: string;
  deviceId: string;
  email: string;
  expiresAt: number;
  refreshToken: string;
  walletAddress: string;
};

type AuthorizedCustomer = {
  email?: string;
  token: string;
  wallet?: string;
};

// The vocabulary of confirmation actions the API publishes, kept exhaustive by the
// compiler the same way as the operation kinds below. It is not the set of actions this
// script performs -- MUTATION_CONTRACTS is that, and neither set contains the other -- so
// a member added here changes nothing but what isConfirmationAction will admit.
const CONFIRMATION_ACTION_FLAGS: Record<
  ConfirmationIntentCreate["action"],
  true
> = {
  "beneficiary_grant.revoke": true,
  "beneficiary_grant.spend": true,
  "card.close": true,
  "card.create": true,
  "card.freeze": true,
  "card.reveal": true,
  "card.unfreeze": true,
  "mandate.create": true,
  "mandate.execute": true,
  "mandate.revoke": true,
  "mandate.revoke_all": true,
  "purchase.create": true,
  "spending_withdrawal.create": true,
  "transfer.create": true,
};

const CONFIRMATION_ACTIONS: ReadonlySet<ConfirmationIntentCreate["action"]> =
  new Set(
    Object.keys(CONFIRMATION_ACTION_FLAGS) as Array<
      ConfirmationIntentCreate["action"]
    >,
  );

function mutationPath(action: MutationAction, resourceId?: string): string {
  return MUTATION_CONTRACTS[action].path(resourceId);
}

const argv = new Set(
  process.argv.slice(2).filter((argument) => argument !== "--"),
);
const checks: Array<CheckState> = [];
const terminal =
  stdin.isTTY && stdout.isTTY
    ? createInterface({ input: stdin, output: stdout })
    : undefined;

function usage(): void {
  console.log(`Usage: pnpm test:live -- [options]

Options:
  --public-only  Call only the public production endpoint
  --no-connect   Do not offer to connect an unlinked Perflo account
  --kyc-session  Create a hosted KYC session after explicit confirmation
  --quotes       Create non-executable service and transfer quotes
  --webhook      Create and then delete PERFLO_LIVE_WEBHOOK_URL
  --mutations    Run explicitly configured live mutations
  --reconcile    Reconcile unresolved mutation journal entries
  --unlock       Remove a verified stale mutation-journal lock
  --help         Show this help

Environment:
  PERFLO_API_BASE_URL                    Override the configured API origin
  PERFLO_CUSTOMER_TOKEN                  Use an existing customer access token
  PERFLO_CONFIRMED_ACCOUNT_EMAIL         Confirm a non-interactive account
  PERFLO_LIVE_SERVICE_QUERY              Capability query; default: web search
  PERFLO_LIVE_TRANSFER_QUOTE             QuoteCreate JSON for --quotes
  PERFLO_LIVE_WEBHOOK_URL                Public HTTPS URL for --webhook
  PERFLO_LIVE_BENEFICIARY                BeneficiaryCreate JSON
  PERFLO_LIVE_CARD_CREATE                CardCreate JSON
  PERFLO_LIVE_CARD_ACTION                {"action","card_id"} JSON
  PERFLO_LIVE_MANDATE                    CreateMandateData["body"] JSON
  PERFLO_LIVE_MANDATE_EXECUTION          {"mandate_id","body"} JSON
  PERFLO_LIVE_BENEFICIARY_GRANT_PAYMENT  {"grant_id","body"} JSON
  PERFLO_LIVE_PURCHASE                   PurchaseCreate JSON
  PERFLO_LIVE_SPENDING_WITHDRAWAL        SpendingWithdrawalCreate JSON
  PERFLO_LIVE_TRANSFER                   QuoteCreate JSON; quote then transfer
  PERFLO_LIVE_SPENDING_WITHDRAWAL_ID     Existing withdrawal detail to read
  PERFLO_LIVE_CARD_REVEAL_ID             Existing card to reveal with --mutations
  PERFLO_LIVE_JOURNAL                    Journal path; default: ${DEFAULT_JOURNAL_PATH}
  PERFLO_LIVE_RECONCILE_ENTRY_ID         Support-verified entry with no operation ID
  PERFLO_LIVE_RECONCILE_OPERATION_ID     Support-verified operation for that entry
  PERFLO_LIVE_RECONCILE_NO_OPERATION     Set to the entry ID when support proves no operation exists
  PERFLO_LIVE_CONNECTION_TIMEOUT_MS      Account-connection polling timeout
  PERFLO_LIVE_OPERATION_TIMEOUT_MS       Operation polling timeout
  PERFLO_LIVE_REQUEST_TIMEOUT_MS         Timeout for each HTTP request
`);
}

function record(state: CheckState, label: string, detail?: string): void {
  checks.push(state);
  console.log(`${state.padEnd(4)} ${label}${detail ? `: ${detail}` : ""}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfirmationAction(
  value: string,
): value is ConfirmationIntentCreate["action"] {
  return CONFIRMATION_ACTIONS.has(value as ConfirmationIntentCreate["action"]);
}

function redactMutationBody(value: unknown, key?: string): unknown {
  if (
    key &&
    /^(accessJwt|account|address|code|details|email|iban|input|phone|refreshToken|routing|secret|token)$/i.test(
      key,
    )
  ) {
    return "[redacted; inspect the configured fixture]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactMutationBody(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactMutationBody(childValue, childKey),
      ]),
    );
  }
  return value;
}

function describeError(error: unknown, response?: Response): string {
  const status = response?.status;
  if (isRecord(error)) {
    const code = typeof error.code === "string" ? error.code : undefined;
    const requestId =
      typeof error.request_id === "string" ? error.request_id : undefined;
    const detail =
      typeof error.detail === "string"
        ? error.detail
        : typeof error.message === "string"
          ? error.message
          : undefined;
    return [
      status,
      code,
      requestId ? `request_id=${requestId}` : undefined,
      detail,
    ]
      .filter((part) => part !== undefined)
      .join(" ");
  }
  return [status, error instanceof Error ? error.message : String(error)]
    .filter((part) => part !== undefined)
    .join(" ");
}

function isDefinitiveSubmissionRejection(
  error: unknown,
  response: Response | undefined,
): boolean {
  return (
    response !== undefined &&
    isRecord(error) &&
    error.status === response.status &&
    isDefinitiveNoOperation(error)
  );
}

function summarize(data: unknown): string {
  if (Array.isArray(data)) {
    return `${data.length} row${data.length === 1 ? "" : "s"}`;
  }
  if (isRecord(data)) {
    if (Array.isArray(data.items)) {
      return `${data.items.length} item${data.items.length === 1 ? "" : "s"}`;
    }
    const state =
      typeof data.state === "string"
        ? data.state
        : typeof data.status === "string"
          ? data.status
          : undefined;
    return state ?? `${Object.keys(data).length} fields`;
  }
  return data === undefined ? "no response body" : typeof data;
}

async function check<T>(
  label: string,
  request: () => PromiseLike<SdkResult<T>>,
  validate: ResultValidator<T>,
): Promise<T | undefined> {
  try {
    const result = await request();
    return recordCheckResult(label, result, validate);
  } catch (error) {
    record("FAIL", label, describeError(error));
    return;
  }
}

function recordCheckResult<T>(
  label: string,
  result: SdkResult<T>,
  validate: ResultValidator<T>,
): T | undefined {
  if (result.error !== undefined) {
    record("FAIL", label, describeError(result.error, result.response));
    return;
  }
  if (result.data === undefined) {
    record("FAIL", label, "success response omitted its required body");
    return;
  }
  const validationError = validate(result.data);
  if (validationError) {
    record("FAIL", label, validationError);
    return;
  }
  record(
    "PASS",
    label,
    `${result.response?.status ?? "ok"}, ${summarize(result.data)}`,
  );
  return result.data;
}

async function checkAuthorizedDevices(client: PerfloClient) {
  try {
    const result = await devices({ client });
    if (result.error !== undefined && result.response?.status === 504) {
      record(
        "SKIP",
        "authorized devices",
        "504 from slow upstream device list",
      );
      return;
    }
    return recordCheckResult("authorized devices", result, requireDeviceList);
  } catch (error) {
    record("FAIL", "authorized devices", describeError(error));
    return;
  }
}

async function raw<T>(
  request: () => PromiseLike<SdkResult<T>>,
): Promise<SdkResult<T>> {
  try {
    return await request();
  } catch (error) {
    return { error };
  }
}

async function capability<T>(
  enabled: boolean,
  label: string,
  request: () => PromiseLike<SdkResult<T>>,
  validate: ResultValidator<T>,
): Promise<T | undefined> {
  if (!enabled) {
    record("SKIP", label, "capability unavailable");
    return;
  }
  return check(label, request, validate);
}

function hasNonemptyStringFields(
  data: unknown,
  fields: ReadonlyArray<string>,
): boolean {
  return (
    isRecord(data) &&
    fields.every(
      (field) => typeof data[field] === "string" && data[field].length > 0,
    )
  );
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is Array<string> {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isNullableStringArray(value: unknown): value is Array<string> | null {
  return value === null || isStringArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isMoney(value: unknown): boolean {
  return hasNonemptyStringFields(value, ["amount", "currency"]);
}

function isNullableMoney(value: unknown): boolean {
  return value === null || isMoney(value);
}

function requireArrayOf(
  label: string,
  predicate: (value: unknown) => boolean,
): ResultValidator<unknown> {
  return (data) =>
    Array.isArray(data) && data.every(predicate)
      ? undefined
      : `success response has no usable ${label} array`;
}

function requireItemsPageOf(
  label: string,
  predicate: (value: unknown) => boolean,
  pagePredicate?: (data: Record<string, unknown>) => boolean,
): ResultValidator<unknown> {
  return (data) =>
    isRecord(data) &&
    Array.isArray(data.items) &&
    data.items.every(predicate) &&
    (pagePredicate?.(data) ?? true)
      ? undefined
      : `success response has no usable ${label} page`;
}

function requireExpectedId(
  label: string,
  expectedId: string,
  predicate: (value: unknown) => boolean,
): ResultValidator<unknown> {
  return (data) => {
    if (!predicate(data)) {
      return `success response has no usable ${label}`;
    }
    return isRecord(data) && data.id === expectedId
      ? undefined
      : `success response ${label} ID does not match ${expectedId}`;
  };
}

const CARD_STATES: ReadonlySet<string> = new Set([
  "pending",
  "active",
  "frozen",
  "failed",
  "closed",
  "expired",
  "freeze_pending",
  "unfreeze_pending",
  "close_pending",
  "indeterminate",
]);

const ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "deposit",
  "withdrawal",
  "payment",
  "transfer",
  "fee",
  "return",
  "reversal",
  "purchase",
]);

const KYC_STATES: ReadonlySet<string> = new Set([
  "not_started",
  "in_progress",
  "action_required",
  "under_review",
  "approved",
  "rejected",
  "expired",
  "unknown",
]);

const MANDATE_KINDS: ReadonlySet<string> = new Set([
  "beneficiary_payment",
  "service_purchase",
]);

const MANDATE_STATES: ReadonlySet<string> = new Set([
  "pending_approval",
  "approval_failed",
  "active",
  "revocation_pending",
  "revocation_failed",
  "revoked",
  "expired",
  "exhausted",
]);

const PURCHASE_STATES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "settling",
  "completed",
  "input_required",
  "no_service_available",
  "services_failed",
  "expired",
  "blocked",
  "confirmation_required",
  "settlement_uncertain",
  "cancelled",
  "failed",
]);

const WITHDRAWAL_STATES: ReadonlySet<string> = new Set([
  "queued",
  "pending",
  "bridging",
  "completed",
  "partial",
  "failed",
  "settlement_uncertain",
]);

function isAccount(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, [
      "id",
      "currency",
      "observed_at",
      "status",
    ]) &&
    isRecord(data) &&
    isNullableMoney(data.available_balance) &&
    isNullableMoney(data.balance) &&
    isNullableMoney(data.pending_balance)
  );
}

function isActivity(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, [
      "id",
      "description",
      "kind",
      "occurred_at",
      "status",
    ]) &&
    isRecord(data) &&
    ACTIVITY_KINDS.has(data.kind as string) &&
    isMoney(data.amount)
  );
}

function isBeneficiaryCountry(data: unknown): boolean {
  return hasNonemptyStringFields(data, ["code", "name"]);
}

function isBeneficiaryField(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, ["key", "type"]) &&
    isRecord(data) &&
    typeof data.required === "boolean" &&
    (data.allowed_values === undefined ||
      data.allowed_values === null ||
      isStringArray(data.allowed_values)) &&
    (data.fields === undefined ||
      data.fields === null ||
      (Array.isArray(data.fields) && data.fields.every(isBeneficiaryField)))
  );
}

function isBeneficiarySchema(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, ["country", "currency", "id", "label"]) &&
    isRecord(data) &&
    Array.isArray(data.fields) &&
    data.fields.every(isBeneficiaryField) &&
    (data.purpose_codes === null || isStringArray(data.purpose_codes))
  );
}

function isBeneficiary(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, ["id", "created_at", "status"]) &&
    isRecord(data) &&
    isNullableString(data.country) &&
    isNullableString(data.currency) &&
    isNullableString(data.destination) &&
    (data.is_external === null || typeof data.is_external === "boolean") &&
    isNullableString(data.name) &&
    isNullableString(data.nickname) &&
    isNullableString(data.payout_schema_id)
  );
}

function isCapability(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, ["id", "name"]) &&
    isRecord(data) &&
    isNullableString(data.description) &&
    isNumber(data.match_count)
  );
}

function isCard(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, ["id", "created_at", "status"]) &&
    isRecord(data) &&
    isMoney(data.balance) &&
    isNullableString(data.last4) &&
    isNullableString(data.nickname) &&
    CARD_STATES.has(data.status as string)
  );
}

function isCardTransaction(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, [
      "id",
      "authorized_at",
      "card_id",
      "description",
      "status",
    ]) &&
    isRecord(data) &&
    isMoney(data.amount) &&
    isMoney(data.fee) &&
    isNullableString(data.settled_at)
  );
}

function isAgentPairing(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, ["display_name", "id"]) &&
    isRecord(data) &&
    isNullableString(data.revoked_at) &&
    (data.verified === undefined || data.verified === false)
  );
}

function isMandate(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, [
      "id",
      "created_at",
      "expires_at",
      "kind",
      "state",
    ]) &&
    isRecord(data) &&
    MANDATE_KINDS.has(data.kind as string) &&
    MANDATE_STATES.has(data.state as string) &&
    isNullableStringArray(data.allowed_capabilities) &&
    isNullableStringArray(data.allowed_services) &&
    Array.isArray(data.authorized_clients) &&
    data.authorized_clients.every(isAgentPairing) &&
    isStringArray(data.authorized_rules) &&
    isNullableString(data.beneficiary_id) &&
    isNullableString(data.destination_currency) &&
    isNullableString(data.purpose_code) &&
    [
      data.daily_max,
      data.monthly_max,
      data.per_payment_max,
      data.total_cap,
      data.weekly_max,
    ].every(isMoney) &&
    isNumber(data.payment_count) &&
    isNullableNumber(data.remaining_payment_count) &&
    [
      data.remaining_daily_max,
      data.remaining_monthly_max,
      data.remaining_total_cap,
      data.remaining_weekly_max,
    ].every(isNullableMoney)
  );
}

function isBeneficiaryGrant(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, ["id", "expires_at", "status"]) &&
    isRecord(data) &&
    isNullableString(data.destination) &&
    isNumber(data.payment_count) &&
    isMoney(data.per_payment_max) &&
    isMoney(data.total_cap) &&
    isNullableNumber(data.uses_count)
  );
}

function isPurchaseTarget(data: unknown): boolean {
  if (!isRecord(data)) {
    return false;
  }
  if (data.kind === "query") {
    return isNonemptyString(data.query);
  }
  if (data.kind === "service") {
    return isNonemptyString(data.service_id);
  }
  return (
    data.kind === "endpoint" &&
    (data.method === "GET" || data.method === "POST") &&
    isNonemptyString(data.url)
  );
}

function isPurchase(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, [
      "id",
      "created_at",
      "operation_id",
      "price_cap_enforcement",
      "status",
    ]) &&
    isRecord(data) &&
    isNullableString(data.completed_at) &&
    isNullableString(data.failure_code) &&
    isNullableString(data.failure_detail) &&
    isMoney(data.max_price) &&
    isNullableString(data.next_reconcile_at) &&
    isNullableMoney(data.price) &&
    (data.price_cap_enforcement === "at_charge" ||
      data.price_cap_enforcement === "preflight") &&
    isNullableString(data.service_id) &&
    PURCHASE_STATES.has(data.status as string) &&
    typeof data.submission_uncertain === "boolean" &&
    isPurchaseTarget(data.target)
  );
}

function isService(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, ["id", "name", "source"]) &&
    isRecord(data) &&
    isNullableString(data.capability) &&
    isNullableString(data.description) &&
    isNullableMoney(data.price) &&
    (data.recommended === null || typeof data.recommended === "boolean") &&
    (data.source === "catalogue" || data.source === "ranked") &&
    (data.verified === null || typeof data.verified === "boolean")
  );
}

function isServiceDetail(data: unknown): boolean {
  return (
    isService(data) &&
    isRecord(data) &&
    (data.input_schema === null || isRecord(data.input_schema))
  );
}

function isWebhookSubscription(data: unknown): boolean {
  return hasNonemptyStringFields(data, ["created_at", "id", "url"]);
}

function isSpendingWithdrawal(data: unknown): boolean {
  return (
    hasNonemptyStringFields(data, [
      "created_at",
      "id",
      "operation_id",
      "status",
    ]) &&
    isRecord(data) &&
    isNullableString(data.completed_at) &&
    isNullableMoney(data.requested) &&
    isNullableMoney(data.settled) &&
    WITHDRAWAL_STATES.has(data.status as string)
  );
}

const requireAccounts = requireArrayOf("account", isAccount);
const requireActivityPage = requireItemsPageOf("activity", isActivity);
const requireBeneficiaries = requireArrayOf("beneficiary", isBeneficiary);
const requireBeneficiaryCountries = requireArrayOf(
  "beneficiary country",
  isBeneficiaryCountry,
);
const requireBeneficiarySchemas = requireArrayOf(
  "beneficiary schema",
  isBeneficiarySchema,
);
const requireCapabilities = requireArrayOf("capability", isCapability);
const requireCards = requireArrayOf("card", isCard);
const requireCardTransactions = requireItemsPageOf(
  "card transaction",
  isCardTransaction,
  (data) =>
    [data.page, data.page_size, data.total, data.total_pages].every(isNumber),
);
const requireMandates = requireArrayOf("mandate", isMandate);
const requireBeneficiaryGrants = requireArrayOf(
  "beneficiary grant",
  isBeneficiaryGrant,
);
const requirePurchases = requireArrayOf("purchase", isPurchase);
const requireServices = requireArrayOf("service", isService);
const requireWebhooks = requireArrayOf(
  "webhook subscription",
  isWebhookSubscription,
);

function requireDeviceList(data: unknown): string | undefined {
  return isRecord(data) &&
    data.success === true &&
    isRecord(data.data) &&
    Array.isArray(data.data.devices) &&
    data.data.devices.every(
      (device) =>
        hasNonemptyStringFields(device, [
          "clientName",
          "deviceId",
          "deviceName",
        ]) &&
        isRecord(device) &&
        isNumber(device.createdAt) &&
        isNumber(device.lastUsedAt) &&
        (device.isGatewayDevice === undefined ||
          device.isGatewayDevice === null ||
          typeof device.isGatewayDevice === "boolean"),
    )
    ? undefined
    : "success response has no usable device envelope";
}

const OPERATION_STATES: ReadonlySet<string> = new Set([
  "requires_action",
  "accepted",
  "submitting",
  "submitted",
  "succeeded",
  "failed",
  "indeterminate",
  "cancelled",
]);

// A mirror of the generated kind union, kept exhaustive by the compiler in both
// directions: Record demands an entry for every member, and the annotation refuses one
// the union does not name. A hand-written set would drift the day a kind is added and
// let the new kind through as an unrecognized operation.
const OPERATION_KIND_FLAGS: Record<OperationView["kind"], true> = {
  beneficiary_create: true,
  beneficiary_grant_payment: true,
  beneficiary_grant_revoke: true,
  card_close: true,
  card_create: true,
  card_freeze: true,
  card_unfreeze: true,
  mandate_create: true,
  mandate_revoke: true,
  mandate_revoke_all: true,
  mandate_suspend: true,
  mandate_transfer: true,
  service_purchase: true,
  spending_withdrawal: true,
  transfer: true,
  transfer_grant_revoke: true,
};

const OPERATION_KINDS: ReadonlySet<string> = new Set(
  Object.keys(OPERATION_KIND_FLAGS),
);

function requireOperation(data: unknown): string | undefined {
  return hasNonemptyStringFields(data, [
    "id",
    "kind",
    "created_at",
    "updated_at",
  ]) &&
    isRecord(data) &&
    typeof data.state === "string" &&
    OPERATION_STATES.has(data.state) &&
    OPERATION_KINDS.has(data.kind as string) &&
    typeof data.approval_resolvable === "boolean" &&
    typeof data.submission_uncertain === "boolean" &&
    isNullableString(data.authority_expires_at) &&
    isNullableString(data.failure_code) &&
    isNullableString(data.failure_detail) &&
    isNullableString(data.next_reconcile_at) &&
    isNullableString(data.resource_id) &&
    isNullableString(data.resource_type) &&
    isNullableString(data.external_reference)
    ? undefined
    : "success response has no usable operation";
}

function requireOperationsArray(data: unknown): string | undefined {
  return Array.isArray(data) &&
    data.every((operation) => requireOperation(operation) === undefined)
    ? undefined
    : "success response has no usable operation array";
}

function requireOperationContinuity(
  expected: Pick<OperationView, "id" | "kind">,
  current: OperationView,
): void {
  const validationError = requireOperation(current);
  if (validationError) {
    throw new Error(validationError);
  }
  if (current.id !== expected.id || current.kind !== expected.kind) {
    throw new Error(
      `operation changed from ${expected.id}/${expected.kind} to ${current.id}/${current.kind}`,
    );
  }
}

function requireIdentity(data: unknown): string | undefined {
  return isRecord(data) &&
    data.actor_type === "customer" &&
    data.client_id === null &&
    isNumber(data.idempotency_replay_window_seconds) &&
    data.idempotency_replay_window_seconds > 0 &&
    isStringArray(data.scopes) &&
    isNonemptyString(data.server_time) &&
    isNonemptyString(data.subject) &&
    isNullableString(data.wallet)
    ? undefined
    : "success response has no usable customer identity";
}

// Typed as ReadonlySet<string> so .has() still takes an unnarrowed body value, but
// constructed over the generated union so a member the contract drops fails to compile
// here instead of silently staying accepted.
const PERFLO_CONNECTION_STATES: ReadonlySet<string> = new Set<
  OnboardingView["perflo_connection"]
>(["pending", "connected", "reconnect_required", "not_connected"]);

const CAPABILITY_FIELDS = [
  "accounts",
  "activity",
  "asset_registry",
  "beneficiaries",
  "beneficiary_create",
  "card_create",
  "card_lifecycle",
  "card_reveal",
  "card_transactions",
  "cards",
  "display_preferences",
  "kyc_session",
  "kyc_status",
  "mandates",
  "purchases",
  "quotes",
  "recipient_metadata",
  "service_catalogue",
  "service_mandates",
  "service_quotes",
  "spending_account",
  "spending_withdrawals",
  "transfers",
] as const;

function requireOnboardingData(data: unknown): string | undefined {
  if (
    !isRecord(data) ||
    typeof data.perflo_connection !== "string" ||
    !PERFLO_CONNECTION_STATES.has(data.perflo_connection) ||
    !isRecord(data.capabilities) ||
    !isRecord(data.customer)
  ) {
    return "success response has no usable onboarding state";
  }
  const capabilities = data.capabilities;
  const customer = data.customer;
  return CAPABILITY_FIELDS.every(
    (field) => typeof capabilities[field] === "boolean",
  ) &&
    typeof data.kyc_session_available === "boolean" &&
    data.kyc_session_available === capabilities.kyc_session &&
    (data.perflo_account_identifier === undefined ||
      isNullableString(data.perflo_account_identifier)) &&
    typeof customer.id === "string" &&
    customer.id.length > 0 &&
    typeof customer.created_at === "string" &&
    typeof customer.locale === "string" &&
    typeof customer.status === "string" &&
    (customer.email === null || typeof customer.email === "string")
    ? undefined
    : "success response has no usable onboarding state";
}

function requireKyc(data: unknown): string | undefined {
  return hasNonemptyStringFields(data, [
    "status",
    "observed_at",
    "status_changed_at",
  ]) &&
    isRecord(data) &&
    KYC_STATES.has(data.status as string) &&
    (data.raw_status === undefined || isNullableString(data.raw_status))
    ? undefined
    : "success response has no usable KYC status";
}

function requireDisplayCurrency(data: unknown): string | undefined {
  return data === null ||
    hasNonemptyStringFields(data, [
      "base_currency",
      "currency",
      "observed_at",
      "units_per_base",
    ])
    ? undefined
    : "success response has no usable display currency";
}

function requireSpendingAccount(data: unknown): string | undefined {
  return isRecord(data) &&
    isMoney(data.held) &&
    isMoney(data.owed) &&
    isMoney(data.promotional_credit)
    ? undefined
    : "success response has no usable spending balances";
}

function requirePurchaseQuote(data: unknown): string | undefined {
  const valid =
    hasNonemptyStringFields(data, ["id", "confirm_by", "quoted_at"]) &&
    isRecord(data) &&
    (data.input_schema === null || isRecord(data.input_schema)) &&
    typeof data.payable === "boolean" &&
    isMoney(data.price) &&
    (data.price_guaranteed === undefined || data.price_guaranteed === false) &&
    isPurchaseTarget(data.target) &&
    isNullableString(data.unpayable_reason);
  if (!valid || !isRecord(data)) {
    return "success response has no usable purchase quote";
  }
  const confirmBy = Date.parse(data.confirm_by as string);
  return Number.isNaN(confirmBy) || confirmBy <= Date.now()
    ? "success response has an expired purchase quote"
    : undefined;
}

function requireTransferQuote(
  data: unknown,
  expected?: QuoteCreate,
): string | undefined {
  const valid =
    hasNonemptyStringFields(data, [
      "beneficiary_id",
      "confirm_by",
      "estimated_at",
      "estimated_payout_rate",
      "id",
      "local_units_per_usd",
    ]) &&
    isRecord(data) &&
    isMoney(data.estimated_destination) &&
    isMoney(data.estimated_fee) &&
    (data.executable === undefined || data.executable === false) &&
    isMoney(data.perflo_cash_debit) &&
    isMoney(data.requested_source);
  if (!valid || !isRecord(data)) {
    return "success response has no usable transfer quote";
  }
  const confirmBy = Date.parse(data.confirm_by as string);
  if (Number.isNaN(confirmBy) || confirmBy <= Date.now()) {
    return "success response has an expired transfer quote";
  }
  if (
    expected &&
    (data.beneficiary_id !== expected.beneficiary_id ||
      !isRecord(data.requested_source) ||
      data.requested_source.amount !== expected.source.amount ||
      data.requested_source.currency !== expected.source.currency)
  ) {
    return "success response does not match the requested transfer quote";
  }
  return undefined;
}

function requireNewWebhook(
  data: unknown,
  expectedUrl: string,
  existingIds: ReadonlySet<string>,
): string | undefined {
  if (
    !hasNonemptyStringFields(data, [
      "id",
      "url",
      "created_at",
      "signing_secret",
    ]) ||
    !isRecord(data) ||
    data.url !== expectedUrl ||
    existingIds.has(data.id as string)
  ) {
    return "create response does not identify a new matching subscription";
  }
  const createdAt = Date.parse(data.created_at as string);
  return Number.isNaN(createdAt)
    ? "create response has an invalid subscription creation time"
    : undefined;
}

function requirePublicConfig(data: unknown): string | undefined {
  return isRecord(data) &&
    typeof data.app_name === "string" &&
    data.app_name.length > 0 &&
    typeof data.app_mark === "string" &&
    data.app_mark.length > 0 &&
    (data.app_name_ar === null || typeof data.app_name_ar === "string")
    ? undefined
    : "success response has no usable public configuration";
}

function requireKycAction(data: unknown): string | undefined {
  if (
    !hasNonemptyStringFields(data, ["url"]) ||
    !isRecord(data) ||
    data.kind !== "kyc_session" ||
    data.poll_after_ms !== null ||
    (data.expires_at !== null && !isNonemptyString(data.expires_at))
  ) {
    return "success response has no usable KYC browser action";
  }
  try {
    requireTrustedAppUrl(data.url as string);
  } catch {
    return "success response has an untrusted KYC browser action";
  }
  if (typeof data.expires_at === "string") {
    const expiresAt = Date.parse(data.expires_at);
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
      return "success response has an expired KYC browser action";
    }
  }
  return undefined;
}

function requireCardRevealAction(data: unknown): string | undefined {
  if (
    !hasNonemptyStringFields(data, ["expires_at", "url"]) ||
    !isRecord(data) ||
    data.kind !== "card_reveal" ||
    data.poll_after_ms !== null
  ) {
    return "success response has no usable card reveal action";
  }
  try {
    requireTrustedAppUrl(data.url as string);
  } catch {
    return "success response has an untrusted card reveal action";
  }
  const expiresAt = Date.parse(data.expires_at as string);
  return Number.isNaN(expiresAt) || expiresAt <= Date.now()
    ? "success response has an expired card reveal action"
    : undefined;
}

function parseEnvJson<T>(name: string): T | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return;
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new TypeError(`${name} is not valid JSON: ${describeError(error)}`);
  }
}

function parseObjectEnvJson<T>(name: string): T | undefined {
  const value = parseEnvJson<unknown>(name);
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    throw new TypeError(`${name} must contain a JSON object, not an array`);
  }
  if (!isRecord(value)) {
    throw new TypeError(`${name} must contain a JSON object`);
  }
  return value as T;
}

function parseCardActionScenario(): CardActionScenario | undefined {
  const value = parseObjectEnvJson<Record<string, unknown>>(
    "PERFLO_LIVE_CARD_ACTION",
  );
  if (!value) {
    return;
  }
  if (
    (value.action !== "freeze" && value.action !== "unfreeze") ||
    typeof value.card_id !== "string" ||
    value.card_id.trim().length === 0
  ) {
    throw new TypeError(
      'PERFLO_LIVE_CARD_ACTION requires {"action":"freeze"|"unfreeze","card_id":"nonempty"}',
    );
  }
  return { action: value.action, card_id: value.card_id };
}

function parseMandateExecutionScenario(): MandateExecutionScenario | undefined {
  const value = parseObjectEnvJson<Record<string, unknown>>(
    "PERFLO_LIVE_MANDATE_EXECUTION",
  );
  if (!value) {
    return;
  }
  if (
    typeof value.mandate_id !== "string" ||
    value.mandate_id.trim().length === 0 ||
    !isRecord(value.body) ||
    typeof value.body.amount !== "string" ||
    value.body.amount.length === 0
  ) {
    throw new TypeError(
      "PERFLO_LIVE_MANDATE_EXECUTION requires nonempty mandate_id and an object body with nonempty amount",
    );
  }
  return {
    body: value.body as MandateExecutionCreate,
    mandate_id: value.mandate_id,
  };
}

function parseBeneficiaryGrantScenario(): BeneficiaryGrantScenario | undefined {
  const value = parseObjectEnvJson<Record<string, unknown>>(
    "PERFLO_LIVE_BENEFICIARY_GRANT_PAYMENT",
  );
  if (!value) {
    return;
  }
  if (
    typeof value.grant_id !== "string" ||
    value.grant_id.trim().length === 0 ||
    !isRecord(value.body) ||
    typeof value.body.amount !== "string" ||
    value.body.amount.length === 0 ||
    typeof value.body.beneficiary_id !== "string" ||
    value.body.beneficiary_id.length === 0
  ) {
    throw new TypeError(
      "PERFLO_LIVE_BENEFICIARY_GRANT_PAYMENT requires nonempty grant_id and an object body with nonempty amount and beneficiary_id",
    );
  }
  return {
    body: value.body as BeneficiaryGrantPaymentCreate,
    grant_id: value.grant_id,
  };
}

function parseWebhookUrl(value: string | undefined): string {
  if (!value) {
    throw new Error("--webhook requires PERFLO_LIVE_WEBHOOK_URL");
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "PERFLO_LIVE_WEBHOOK_URL must be public HTTPS without credentials, query, or fragment",
    );
  }
  return url.href;
}

function requireSafeApiBaseUrl(value: string | undefined): URL {
  const url = new URL(value ?? PERFLO_API_ORIGIN);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !["/", "/v1", "/v1/"].includes(url.pathname)
  ) {
    throw new TypeError(
      "PERFLO_API_BASE_URL must be HTTPS, except for an HTTP loopback test server, and contain only an origin or /v1",
    );
  }
  return url;
}

function readLiveConfig(selected = argv): LiveConfig {
  const reconciliation = selected.has("--reconcile")
    ? readReconciliationConfig()
    : { kind: "none" as const };
  const mutations: MutationFixtures = selected.has("--mutations")
    ? {
        beneficiary: parseObjectEnvJson<BeneficiaryCreate>(
          "PERFLO_LIVE_BENEFICIARY",
        ),
        cardAction: parseCardActionScenario(),
        cardCreate: parseObjectEnvJson<CardCreate>("PERFLO_LIVE_CARD_CREATE"),
        mandate: parseObjectEnvJson<CreateMandateData["body"]>(
          "PERFLO_LIVE_MANDATE",
        ),
        mandateExecution: parseMandateExecutionScenario(),
        beneficiaryGrant: parseBeneficiaryGrantScenario(),
        purchase: parseObjectEnvJson<PurchaseCreate>("PERFLO_LIVE_PURCHASE"),
        revealCardId:
          process.env.PERFLO_LIVE_CARD_REVEAL_ID?.trim() || undefined,
        transfer: parseObjectEnvJson<QuoteCreate>("PERFLO_LIVE_TRANSFER"),
        withdrawal: parseObjectEnvJson<SpendingWithdrawalCreate>(
          "PERFLO_LIVE_SPENDING_WITHDRAWAL",
        ),
      }
    : {};
  return {
    connectionTimeoutMs: positiveIntegerEnv(
      "PERFLO_LIVE_CONNECTION_TIMEOUT_MS",
      DEFAULT_CONNECTION_TIMEOUT_MS,
    ),
    mutations,
    operationTimeoutMs: positiveIntegerEnv(
      "PERFLO_LIVE_OPERATION_TIMEOUT_MS",
      DEFAULT_OPERATION_TIMEOUT_MS,
    ),
    reconciliation,
    ...(selected.has("--quotes")
      ? {
          transferQuote: parseObjectEnvJson<QuoteCreate>(
            "PERFLO_LIVE_TRANSFER_QUOTE",
          ),
        }
      : {}),
    ...(selected.has("--webhook")
      ? {
          webhookUrl: parseWebhookUrl(
            process.env.PERFLO_LIVE_WEBHOOK_URL?.trim(),
          ),
        }
      : {}),
  };
}

function readReconciliationConfig(): ReconciliationConfig {
  const entryId = process.env.PERFLO_LIVE_RECONCILE_ENTRY_ID?.trim();
  const operationId = process.env.PERFLO_LIVE_RECONCILE_OPERATION_ID?.trim();
  const noOperationEntryId =
    process.env.PERFLO_LIVE_RECONCILE_NO_OPERATION?.trim();
  if (operationId && noOperationEntryId) {
    throw new Error(
      "set either PERFLO_LIVE_RECONCILE_OPERATION_ID or PERFLO_LIVE_RECONCILE_NO_OPERATION, not both",
    );
  }
  if ((operationId || noOperationEntryId) && !entryId) {
    throw new Error(
      "manual reconciliation requires PERFLO_LIVE_RECONCILE_ENTRY_ID",
    );
  }
  if (noOperationEntryId && noOperationEntryId !== entryId) {
    throw new Error(
      "PERFLO_LIVE_RECONCILE_NO_OPERATION must equal PERFLO_LIVE_RECONCILE_ENTRY_ID",
    );
  }
  if (entryId && !operationId && !noOperationEntryId) {
    throw new Error(
      "PERFLO_LIVE_RECONCILE_ENTRY_ID requires operation or no-operation evidence",
    );
  }
  if (entryId && operationId) {
    return { entryId, kind: "operation", operationId };
  }
  if (entryId && noOperationEntryId) {
    return { entryId, kind: "no_operation" };
  }
  return { kind: "none" };
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new TypeError(`${name} must be an integer from 1 to 2147483647`);
  }
  return parsed;
}

function requireTrustedAppUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== TRUSTED_APP_ORIGIN) {
    throw new TypeError(`browser action must use ${TRUSTED_APP_ORIGIN}`);
  }
  return url;
}

function mask(value: string): string {
  if (value.length <= 10) {
    return "***";
  }
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedDelay(
  requestedMilliseconds: number,
  deadline: number,
  now = Date.now(),
): number {
  return Math.max(0, Math.min(requestedMilliseconds, deadline - now));
}

function deadlineSignal(deadline: number): AbortSignal {
  const remaining = deadline - Date.now();
  return remaining <= 0
    ? AbortSignal.abort(new Error("request deadline expired"))
    : AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
}

function boundedFetch(
  timeout: number,
  implementation: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request =
      input instanceof Request && init === undefined
        ? input
        : new Request(input, init);
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(timeout),
    ]);
    return await implementation(new Request(request, { signal }));
  };
}

function retryAfterMilliseconds(response?: Response): number | undefined {
  const value = response?.headers.get("Retry-After");
  if (!value) {
    return;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function requireInput(prompt: string): Promise<string> {
  if (!terminal) {
    throw new Error(`${prompt} requires an interactive terminal`);
  }
  return (await terminal.question(prompt)).trim();
}

async function requirePhrase(label: string, phrase: string): Promise<void> {
  const answer = await requireInput(`${label}\nType ${phrase} to continue: `);
  if (answer !== phrase) {
    throw new Error(`confirmation for ${label} was not accepted`);
  }
}

function validateDeviceCredentials(value: unknown): ValidDeviceCredentials {
  if (!isRecord(value)) {
    throw new TypeError("device authorization returned no credential set");
  }
  const stringFields = [
    "accessJwt",
    "refreshToken",
    "deviceId",
    "email",
    "walletAddress",
  ] as const;
  for (const field of stringFields) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new TypeError(`device authorization omitted ${field}`);
    }
  }
  if (
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= Date.now()
  ) {
    throw new TypeError("device authorization returned an invalid expiresAt");
  }
  return value as ValidDeviceCredentials;
}

async function authorizeDevice(
  publicClient: PerfloClient,
): Promise<AuthorizedCustomer> {
  const suppliedToken = process.env.PERFLO_CUSTOMER_TOKEN?.trim();
  if (suppliedToken) {
    record("PASS", "customer credential", "read from PERFLO_CUSTOMER_TOKEN");
    return { token: suppliedToken };
  }
  if (!terminal) {
    throw new Error(
      "set PERFLO_CUSTOMER_TOKEN or run account authorization in a terminal",
    );
  }

  const started = await raw(() =>
    startDevice({
      body: {
        clientName: "Perflo Finance SDK live exercise",
        deviceName: process.env.PERFLO_LIVE_DEVICE_NAME ?? "Local terminal",
      },
      client: publicClient,
      signal: AbortSignal.timeout(DEFAULT_CONNECTION_TIMEOUT_MS),
    }),
  );
  const session = started.data?.data;
  if (
    started.error !== undefined ||
    started.data?.success !== true ||
    !session ||
    typeof session.sid !== "string" ||
    session.sid.length === 0 ||
    !Number.isFinite(session.pollInterval) ||
    session.pollInterval <= 0 ||
    !Number.isFinite(session.expiresIn) ||
    session.expiresIn <= 0
  ) {
    throw new Error(
      `device authorization failed: ${describeError(started.error, started.response)}`,
    );
  }
  const connectUrl = requireTrustedAppUrl(session.connectUrl);
  console.log(
    `\nOpen this one-time URL and approve the named device:\n${connectUrl}\n`,
  );

  const deadline = Date.now() + session.expiresIn * 1000;
  const interval = Math.max(500, session.pollInterval);
  while (Date.now() < deadline) {
    await sleep(boundedDelay(interval, deadline));
    if (Date.now() >= deadline) {
      break;
    }
    const polled = await raw(() =>
      pollDevice({
        body: { sid: session.sid },
        client: publicClient,
        signal: deadlineSignal(deadline),
      }),
    );
    if (polled.error !== undefined) {
      if (polled.response?.status === 429) {
        await sleep(
          boundedDelay(
            retryAfterMilliseconds(polled.response) ?? 60_000,
            deadline,
          ),
        );
        continue;
      }
      throw new Error(
        `device poll failed: ${describeError(polled.error, polled.response)}`,
      );
    }
    if (polled.data?.success !== true || !polled.data.data) {
      throw new Error("device poll returned an unusable success envelope");
    }
    const state = polled.data.data;
    if (state.status === "pending") {
      continue;
    }
    if (state.status !== "complete") {
      throw new Error(`device authorization ended with ${state.status}`);
    }
    const credentials = validateDeviceCredentials(state.result);
    record("PASS", "device authorization", `approved for ${credentials.email}`);
    return {
      email: credentials.email,
      token: credentials.accessJwt,
      wallet: credentials.walletAddress,
    };
  }
  throw new Error("device authorization expired before completion");
}

function requireDevicePrincipalMatch(
  authorized: AuthorizedCustomer,
  state: OnboardingView,
  identity: { wallet: string | null },
): void {
  if (authorized.email !== undefined) {
    const authenticatedEmail = state.customer.email;
    if (
      authenticatedEmail !== null &&
      authorized.email.trim().toLowerCase() !==
        authenticatedEmail.trim().toLowerCase()
    ) {
      throw new Error(
        "device authorization email does not match the authenticated customer",
      );
    }
  }
  if (authorized.wallet !== undefined) {
    if (
      identity.wallet === null ||
      authorized.wallet.trim().toLowerCase() !==
        identity.wallet.trim().toLowerCase()
    ) {
      throw new Error(
        "device authorization wallet does not match the authenticated customer",
      );
    }
  }
  if (authorized.email !== undefined || authorized.wallet !== undefined) {
    record(
      "PASS",
      "device principal binding",
      `${state.customer.email ?? "email unavailable"}${
        identity.wallet ? ` (${mask(identity.wallet)})` : ""
      }`,
    );
  }
}

async function confirmAccount(
  expectedEmail: string | undefined,
  wallet: string | undefined,
): Promise<void> {
  if (!expectedEmail) {
    throw new Error("the authenticated account has no email to confirm");
  }
  const configured = process.env.PERFLO_CONFIRMED_ACCOUNT_EMAIL?.trim();
  if (configured !== undefined) {
    if (configured.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error(
        `PERFLO_CONFIRMED_ACCOUNT_EMAIL does not match ${expectedEmail}`,
      );
    }
  } else {
    const suffix = wallet ? ` (${mask(wallet)})` : "";
    const answer = await requireInput(
      `Connected account: ${expectedEmail}${suffix}\nType the email to confirm it is yours: `,
    );
    if (answer.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error("connected account was not confirmed");
    }
  }
  record("PASS", "account confirmation", expectedEmail);
}

async function readOnboarding(
  client: PerfloClient,
  label = "onboarding",
  deadline?: number,
): Promise<OnboardingView> {
  const result = await raw(() =>
    onboarding({
      client,
      ...(deadline === undefined ? {} : { signal: deadlineSignal(deadline) }),
    }),
  );
  if (result.error !== undefined || result.data === undefined) {
    throw new Error(
      `${label} failed: ${describeError(result.error, result.response)}`,
    );
  }
  const validationError = requireOnboardingData(result.data);
  if (validationError) {
    throw new Error(`${label} failed: ${validationError}`);
  }
  record("PASS", label, result.data.perflo_connection);
  return result.data;
}

async function ensurePerfloConnection(
  client: PerfloClient,
  current: OnboardingView,
  timeout: number,
  confirm: typeof requirePhrase = requirePhrase,
  wait: typeof sleep = sleep,
  acknowledge: typeof requireInput = requireInput,
): Promise<OnboardingView> {
  if (current.perflo_connection === "connected") {
    return current;
  }
  if (argv.has("--no-connect")) {
    record("SKIP", "Perflo account connection", "disabled by --no-connect");
    return current;
  }
  if (current.perflo_connection === "reconnect_required") {
    console.log("The existing Perflo connection needs replacement.");
  }
  await confirm("Create or resume the gateway's Perflo device?", "CONNECT");

  const deadline = Date.now() + timeout;
  const started = await raw(() =>
    startPerfloConnection({ client, signal: deadlineSignal(deadline) }),
  );
  if (started.error !== undefined || started.data === undefined) {
    throw new Error(
      `Perflo connection start failed: ${describeError(started.error, started.response)}`,
    );
  }
  let connection = started.data;
  let openedActionUrl: string | undefined;
  while (connection.status === "pending") {
    if (Date.now() >= deadline) {
      throw new Error(
        `Perflo connection remained pending after ${timeout} ms; rerun to resume it`,
      );
    }
    const action = connection.action;
    if (!action) {
      await wait(boundedDelay(3000, deadline));
    } else {
      if (action.kind !== "connect") {
        throw new Error(`unexpected Perflo connection action ${action.kind}`);
      }
      const url = requireTrustedAppUrl(action.url);
      if (openedActionUrl !== url.href) {
        console.log(
          `\nOpen this one-time URL and approve the gateway device:\n${url}\n`,
        );
        await acknowledge("Press Enter after approving the connection: ");
        openedActionUrl = url.href;
      }
      const expiresAt = action.expires_at
        ? Date.parse(action.expires_at)
        : undefined;
      if (
        expiresAt === undefined ||
        Number.isNaN(expiresAt) ||
        typeof action.poll_after_ms !== "number" ||
        !Number.isFinite(action.poll_after_ms) ||
        action.poll_after_ms <= 0
      ) {
        throw new Error("Perflo connection returned an invalid browser action");
      }
      if (Date.now() >= expiresAt) {
        throw new Error("Perflo connection browser action expired");
      }
      const actionDeadline = Math.min(deadline, expiresAt);
      await wait(
        boundedDelay(Math.max(500, action.poll_after_ms), actionDeadline),
      );
      if (Date.now() >= expiresAt) {
        throw new Error("Perflo connection browser action expired");
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Perflo connection remained pending after ${timeout} ms; rerun to resume it`,
      );
    }

    const polled = await raw(() =>
      pollPerfloConnection({ client, signal: deadlineSignal(deadline) }),
    );
    if (polled.error !== undefined || polled.data === undefined) {
      const reconciled = await readOnboarding(
        client,
        "connection reconciliation",
        deadline,
      );
      if (reconciled.perflo_connection === "connected") {
        record("PASS", "Perflo account connection", "connected");
        return reconciled;
      }
      if (reconciled.perflo_connection === "pending") {
        const resumed = await raw(() =>
          startPerfloConnection({
            client,
            signal: deadlineSignal(deadline),
          }),
        );
        if (resumed.error !== undefined || resumed.data === undefined) {
          throw new Error(
            `connection resume failed: ${describeError(resumed.error, resumed.response)}`,
          );
        }
        connection = resumed.data;
        continue;
      }
      throw new Error(
        `connection poll failed and onboarding reports ${reconciled.perflo_connection}`,
      );
    }
    connection = polled.data;
  }

  if (connection.status !== "connected") {
    throw new Error(`Perflo connection ended with ${connection.status}`);
  }
  let connected = await readOnboarding(
    client,
    "connected onboarding",
    deadline,
  );
  while (connected.perflo_connection === "pending" && Date.now() < deadline) {
    await wait(boundedDelay(2000, deadline));
    if (Date.now() >= deadline) {
      break;
    }
    connected = await readOnboarding(
      client,
      "connected onboarding retry",
      deadline,
    );
  }
  if (connected.perflo_connection !== "connected") {
    throw new Error(
      `connection endpoint completed but onboarding reports ${connected.perflo_connection}`,
    );
  }
  record(
    "PASS",
    "Perflo account connection",
    connected.perflo_account_identifier ?? "connected",
  );
  return connected;
}

async function runReadSweep(
  client: PerfloClient,
  state: OnboardingView,
): Promise<ReadContext> {
  const connected = state.perflo_connection === "connected";
  const capabilities = state.capabilities;
  const gate = (enabled: boolean) => connected && enabled;

  const beneficiaryRows = await capability(
    gate(capabilities.beneficiaries),
    "beneficiaries",
    () => beneficiaries({ client }),
    requireBeneficiaries,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  const cardRows = await capability(
    gate(capabilities.cards),
    "cards",
    () => cards({ client }),
    requireCards,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  const mandateRows = await capability(
    gate(capabilities.mandates),
    "mandates",
    () => mandates({ client }),
    requireMandates,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  const operationRows = await check(
    "operations",
    () => listOperations({ client, query: { limit: 50 } }),
    requireOperationsArray,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  const purchaseRows = await capability(
    gate(capabilities.purchases),
    "purchases",
    () => purchases({ client, query: { limit: 50, offset: 0 } }),
    requirePurchases,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  const serviceRows = await capability(
    gate(capabilities.service_catalogue),
    "services",
    () => services({ client, query: { limit: 25 } }),
    requireServices,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  await check(
    "webhook subscriptions",
    () => listSubscriptions({ client }),
    requireWebhooks,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  const countryRows = await capability(
    gate(capabilities.recipient_metadata),
    "beneficiary countries",
    () => beneficiaryCountries({ client }),
    requireBeneficiaryCountries,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  await capability(
    gate(capabilities.kyc_status),
    "KYC status",
    () => kycStatus({ client }),
    requireKyc,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  await capability(
    gate(capabilities.accounts),
    "deposit accounts",
    () => accounts({ client }),
    requireAccounts,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  await capability(
    gate(capabilities.activity),
    "activity",
    () => activity({ client, query: { limit: 25 } }),
    requireActivityPage,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  await capability(
    gate(capabilities.display_preferences),
    "display currency",
    () => displayCurrency({ client }),
    requireDisplayCurrency,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  await capability(
    gate(capabilities.spending_account),
    "spending account",
    () => spendingAccount({ client }),
    requireSpendingAccount,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  await capability(
    gate(capabilities.service_catalogue),
    "service capabilities",
    () =>
      serviceCapabilities({
        client,
        query: {
          query: process.env.PERFLO_LIVE_SERVICE_QUERY ?? "web search",
        },
      }),
    requireCapabilities,
  );
  await sleep(DEFAULT_READ_DELAY_MS);
  await checkAuthorizedDevices(client);

  record(
    listActivity === activity ? "PASS" : "FAIL",
    "listActivity alias",
    "same generated operation",
  );
  record(
    listServices === services ? "PASS" : "FAIL",
    "listServices alias",
    "same generated operation",
  );

  const detailChecks: Array<() => Promise<unknown>> = [];
  const firstBeneficiary = beneficiaryRows?.[0];
  if (firstBeneficiary) {
    detailChecks.push(() =>
      check(
        "beneficiary detail",
        () =>
          getBeneficiary({
            client,
            path: { beneficiary_id: firstBeneficiary.id },
          }),
        requireExpectedId("beneficiary", firstBeneficiary.id, isBeneficiary),
      ),
    );
  } else {
    record("SKIP", "beneficiary detail", "no beneficiary returned");
  }

  const firstCountry = countryRows?.[0] as BeneficiaryCountry | undefined;
  if (firstCountry) {
    detailChecks.push(() =>
      check(
        "beneficiary schemas",
        () =>
          beneficiarySchemas({
            client,
            query: { country: firstCountry.code },
          }),
        requireBeneficiarySchemas,
      ),
    );
  } else {
    record("SKIP", "beneficiary schemas", "no country returned");
  }

  const firstCard = cardRows?.[0];
  if (firstCard && capabilities.card_transactions) {
    detailChecks.push(() =>
      check(
        "card transactions",
        () =>
          cardTransactions({
            client,
            path: { card_id: firstCard.id },
            query: { page: 1, page_size: 25 },
          }),
        requireCardTransactions,
      ),
    );
  } else {
    record(
      "SKIP",
      "card transactions",
      firstCard ? "capability unavailable" : "no card returned",
    );
  }

  const firstMandate = mandateRows?.[0];
  if (firstMandate) {
    detailChecks.push(() =>
      check(
        "mandate detail",
        () => getMandate({ client, path: { mandate_id: firstMandate.id } }),
        requireExpectedId("mandate", firstMandate.id, isMandate),
      ),
    );
  } else {
    record("SKIP", "mandate detail", "no mandate returned");
  }

  if (gate(capabilities.mandates)) {
    detailChecks.push(() =>
      check(
        "beneficiary grants",
        () => mandateBeneficiaryGrants({ client }),
        requireBeneficiaryGrants,
      ),
    );
  } else {
    record("SKIP", "beneficiary grants", "capability unavailable");
  }

  const firstOperation = operationRows?.[0];
  if (firstOperation) {
    detailChecks.push(() =>
      check(
        "operation detail",
        () =>
          getOperation({ client, path: { operation_id: firstOperation.id } }),
        requireExpectedId(
          "operation",
          firstOperation.id,
          (data) => requireOperation(data) === undefined,
        ),
      ),
    );
  } else {
    record("SKIP", "operation detail", "no operation returned");
  }

  const firstPurchase = purchaseRows?.[0];
  if (firstPurchase) {
    detailChecks.push(() =>
      check(
        "purchase detail",
        () => getPurchase({ client, path: { purchase_id: firstPurchase.id } }),
        requireExpectedId("purchase", firstPurchase.id, isPurchase),
      ),
    );
  } else {
    record("SKIP", "purchase detail", "no purchase returned");
  }

  const firstService = serviceRows?.[0];
  if (firstService) {
    detailChecks.push(() =>
      check(
        "service detail",
        () => getService({ client, path: { service_id: firstService.id } }),
        requireExpectedId("service", firstService.id, isServiceDetail),
      ),
    );
  } else {
    record("SKIP", "service detail", "no service returned");
  }

  const withdrawalId = process.env.PERFLO_LIVE_SPENDING_WITHDRAWAL_ID?.trim();
  if (withdrawalId) {
    detailChecks.push(() =>
      capability(
        gate(capabilities.spending_withdrawals),
        "spending withdrawal detail",
        () =>
          getSpendingWithdrawal({
            client,
            path: { withdrawal_id: withdrawalId },
          }),
        requireExpectedId(
          "spending withdrawal",
          withdrawalId,
          isSpendingWithdrawal,
        ),
      ),
    );
  } else {
    record(
      "SKIP",
      "spending withdrawal detail",
      "PERFLO_LIVE_SPENDING_WITHDRAWAL_ID is unset",
    );
  }

  for (const detailCheck of detailChecks) {
    await sleep(DEFAULT_READ_DELAY_MS);
    await detailCheck();
  }
  return {
    services: serviceRows,
  };
}

async function runQuotes(
  client: PerfloClient,
  state: OnboardingView,
  context: ReadContext,
  transferQuote: QuoteCreate | undefined,
): Promise<void> {
  if (!argv.has("--quotes")) {
    record("SKIP", "live quotes", "enable with --quotes");
    return;
  }
  if (
    state.perflo_connection === "connected" &&
    state.capabilities.service_quotes &&
    context.services?.[0]
  ) {
    const service = context.services[0];
    await check(
      "service purchase quote",
      () =>
        createPurchaseQuote({
          body: {
            target: {
              kind: "service",
              service_id: service.id,
            },
          },
          client,
        }),
      (data) => {
        const validationError = requirePurchaseQuote(data);
        if (validationError || !isRecord(data) || !isRecord(data.target)) {
          return validationError ?? "purchase quote target is missing";
        }
        return data.target.kind === "service" &&
          data.target.service_id === service.id
          ? undefined
          : "purchase quote target does not match the requested service";
      },
    );
  } else {
    record("SKIP", "service purchase quote", "no supported service returned");
  }

  if (!transferQuote) {
    record("SKIP", "transfer quote", "PERFLO_LIVE_TRANSFER_QUOTE is unset");
  } else {
    await capability(
      state.perflo_connection === "connected" && state.capabilities.quotes,
      "transfer quote",
      () => createQuote({ body: transferQuote, client }),
      (data) => requireTransferQuote(data, transferQuote),
    );
  }
}

async function runKycSession(
  client: PerfloClient,
  state: OnboardingView,
): Promise<void> {
  if (!argv.has("--kyc-session")) {
    record("SKIP", "KYC browser session", "enable with --kyc-session");
    return;
  }
  if (
    state.perflo_connection !== "connected" ||
    !state.capabilities.kyc_session
  ) {
    record("SKIP", "KYC browser session", "capability unavailable");
    return;
  }
  await requirePhrase("Create a hosted KYC session for this account?", "KYC");
  const created = await raw(() => createKycSession({ client }));
  if (created.error !== undefined || created.data === undefined) {
    record(
      "FAIL",
      "KYC browser session",
      describeError(created.error, created.response),
    );
    return;
  }
  const validationError = requireKycAction(created.data);
  if (validationError) {
    record("FAIL", "KYC browser session", validationError);
    return;
  }
  if (
    created.data.expires_at !== null &&
    Date.now() >= Date.parse(created.data.expires_at)
  ) {
    record("FAIL", "KYC browser session", "browser action expired");
    return;
  }
  record(
    "PASS",
    "KYC browser session",
    `${created.response?.status ?? "ok"}, trusted hosted action`,
  );
  console.log(
    `Open the one-time KYC URL in your browser:\n${created.data.url}\n`,
  );
}

async function runWebhook(
  client: PerfloClient,
  options: {
    confirm?: typeof requirePhrase;
    enabled?: boolean;
    url?: string;
  } = {},
): Promise<void> {
  if (!(options.enabled ?? argv.has("--webhook"))) {
    record("SKIP", "webhook create/delete", "enable with --webhook");
    return;
  }
  const value =
    options.url?.trim() ?? process.env.PERFLO_LIVE_WEBHOOK_URL?.trim();
  const url = new URL(parseWebhookUrl(value));
  await (options.confirm ?? requirePhrase)(
    `Create and immediately delete webhook ${url.origin}${url.pathname}?`,
    "WEBHOOK",
  );
  const baseline = await check(
    "webhook baseline",
    () => listSubscriptions({ client }),
    requireWebhooks,
  );
  if (!baseline) {
    return;
  }
  const existingIds = new Set(baseline.map((subscription) => subscription.id));
  const created = await raw(() =>
    createSubscription({ body: { url: url.href }, client }),
  );
  if (created.error !== undefined) {
    await reportUnknownWebhookCreate(
      client,
      url.href,
      existingIds,
      describeError(created.error, created.response),
    );
    return;
  }
  if (created.data === undefined) {
    await reportUnknownWebhookCreate(
      client,
      url.href,
      existingIds,
      "success response omitted its required body",
    );
    return;
  }
  const validationError = requireNewWebhook(
    created.data,
    url.href,
    existingIds,
  );
  if (validationError) {
    await reportUnknownWebhookCreate(
      client,
      url.href,
      existingIds,
      validationError,
    );
    return;
  }
  record(
    "PASS",
    "webhook create",
    `${created.response?.status ?? "ok"}, signing secret withheld`,
  );
  await deleteWebhookAndReconcile(client, created.data.id, "webhook delete");
}

async function reportUnknownWebhookCreate(
  client: PerfloClient,
  url: string,
  existingIds: ReadonlySet<string>,
  detail: string,
): Promise<void> {
  record("FAIL", "webhook create", detail);
  const reconciled = await check(
    "webhook create reconciliation",
    () => listSubscriptions({ client }),
    requireWebhooks,
  );
  const candidates = reconciled?.filter(
    (subscription) =>
      subscription.url === url && !existingIds.has(subscription.id),
  );
  if (candidates && candidates.length > 0) {
    record(
      "FAIL",
      "webhook create manual cleanup",
      `create outcome is unknown; inspect new subscription IDs without deleting them: ${candidates.map((item) => item.id).join(", ")}`,
    );
  }
}

async function deleteWebhookAndReconcile(
  client: PerfloClient,
  subscriptionId: string,
  label: string,
): Promise<void> {
  const deleted = await raw(() =>
    deleteSubscription({
      client,
      path: { subscription_id: subscriptionId },
    }),
  );
  if (deleted.error === undefined && deleted.response?.status === 204) {
    record("PASS", label, "204, subscription deleted");
    return;
  }
  record(
    "FAIL",
    label,
    `${describeError(deleted.error, deleted.response)}; subscription ID ${subscriptionId}`,
  );
  const subscriptions = await check(
    `${label} reconciliation`,
    () => listSubscriptions({ client }),
    requireWebhooks,
  );
  if (
    subscriptions?.some((subscription) => subscription.id === subscriptionId)
  ) {
    record(
      "FAIL",
      `${label} manual cleanup`,
      `subscription still active: ${subscriptionId}`,
    );
  } else if (subscriptions) {
    record("PASS", `${label} reconciliation result`, "subscription absent");
  }
}

function jwtIssuedAtMilliseconds(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) {
    return;
  }
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return isRecord(decoded) && typeof decoded.iat === "number"
      ? decoded.iat * 1000
      : undefined;
  } catch {
    return;
  }
}

function requireFreshCustomerToken(token: string): void {
  const issuedAt = jwtIssuedAtMilliseconds(token);
  if (issuedAt === undefined || Math.abs(Date.now() - issuedAt) > 5 * 60_000) {
    throw new Error(
      "live confirmed actions need a customer token issued within five minutes; rerun without PERFLO_CUSTOMER_TOKEN",
    );
  }
}

const JOURNAL_STATUSES: ReadonlySet<JournalStatus> = new Set([
  "planned",
  "confirmed",
  "submitted",
  "succeeded",
  "failed",
  "cancelled",
  "rejected",
  "unresolved",
  "indeterminate",
]);

function sameJournalContext(
  left: JournalContext,
  right: JournalContext,
): boolean {
  return (
    left.api_origin === right.api_origin &&
    left.customer_id === right.customer_id &&
    left.subject === right.subject
  );
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (!isRecord(value)) {
    return false;
  }
  const requiredStrings = [
    "action",
    "created_at",
    "id",
    "idempotency_key",
    "path",
    "updated_at",
  ] as const;
  return (
    "body" in value &&
    requiredStrings.every(
      (field) => typeof value[field] === "string" && value[field].length > 0,
    ) &&
    expectedOperationKind(value.action as string) !== undefined &&
    value.method === "POST" &&
    typeof value.status === "string" &&
    JOURNAL_STATUSES.has(value.status as JournalStatus) &&
    (value.confirmation_intent_id === undefined ||
      typeof value.confirmation_intent_id === "string") &&
    (value.operation_id === undefined ||
      typeof value.operation_id === "string") &&
    (value.response_operation_id === undefined ||
      typeof value.response_operation_id === "string") &&
    (value.submission_started_at === undefined ||
      typeof value.submission_started_at === "string") &&
    (value.confirmation_payload === undefined ||
      isRecord(value.confirmation_payload))
  );
}

async function loadJournal(
  path: string,
  expectedContext: JournalContext,
): Promise<Journal> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !isRecord(parsed) ||
      parsed.version !== 2 ||
      !isRecord(parsed.context) ||
      typeof parsed.context.api_origin !== "string" ||
      typeof parsed.context.customer_id !== "string" ||
      typeof parsed.context.subject !== "string" ||
      !Array.isArray(parsed.entries) ||
      !parsed.entries.every(isJournalEntry)
    ) {
      throw new TypeError("journal has an invalid shape");
    }
    const journal = parsed as Journal;
    if (!sameJournalContext(journal.context, expectedContext)) {
      throw new Error(
        "journal belongs to a different API origin or authenticated customer",
      );
    }
    return journal;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { context: expectedContext, entries: [], version: 2 };
    }
    throw error;
  }
}

async function saveJournal(path: string, journal: Journal): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryFile: FileHandle | undefined;
  try {
    temporaryFile = await open(temporary, "wx", 0o600);
    await temporaryFile.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(resolve(path)), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await temporaryFile?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function withJournalLock<T>(
  journalPath: string,
  task: () => Promise<T>,
): Promise<T> {
  const lockPath = `${journalPath}.lock`;
  let lock: FileHandle;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error(
        `${lockPath} already exists; another mutation or reconciliation run may be active`,
      );
    }
    throw error;
  }
  const removeLockAtExit = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      return;
    }
  };
  process.once("exit", removeLockAtExit);
  try {
    await lock.writeFile(
      `${JSON.stringify({ created_at: new Date().toISOString(), pid: process.pid })}\n`,
    );
    return await task();
  } finally {
    try {
      await lock.close();
      await unlink(lockPath).catch((error: unknown) => {
        if (!isRecord(error) || error.code !== "ENOENT") {
          throw error;
        }
      });
    } finally {
      process.removeListener("exit", removeLockAtExit);
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isRecord(error) || error.code !== "ESRCH";
  }
}

async function unlockJournal(
  confirm: typeof requirePhrase = requirePhrase,
): Promise<void> {
  if (!terminal && confirm === requirePhrase) {
    throw new Error("--unlock requires an interactive terminal");
  }
  const journalPath =
    process.env.PERFLO_LIVE_JOURNAL?.trim() || DEFAULT_JOURNAL_PATH;
  const lockPath = `${journalPath}.lock`;
  let contents: string;
  let lockAge: number;
  try {
    const [value, metadata] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath),
    ]);
    contents = value;
    lockAge = Date.now() - metadata.mtimeMs;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      record("PASS", "journal unlock", "no lock file exists");
      return;
    }
    throw error;
  }
  let ownerPid: number | undefined;
  try {
    const metadata: unknown = JSON.parse(contents);
    if (
      isRecord(metadata) &&
      typeof metadata.pid === "number" &&
      Number.isSafeInteger(metadata.pid) &&
      metadata.pid > 0
    ) {
      ownerPid = metadata.pid;
    }
  } catch {
    ownerPid = undefined;
  }
  if (ownerPid !== undefined && processExists(ownerPid)) {
    throw new Error(
      `${lockPath} belongs to active process ${ownerPid}; do not remove it`,
    );
  }
  if (ownerPid === undefined && lockAge < 60_000) {
    throw new Error(
      `${lockPath} has no readable owner and is less than one minute old; wait and check again`,
    );
  }
  const owner = ownerPid === undefined ? "UNKNOWN" : String(ownerPid);
  await confirm(
    `No active owner was found for ${lockPath}.`,
    `UNLOCK ${owner}`,
  );
  await unlink(lockPath);
  record("PASS", "journal unlock", `${lockPath} removed`);
}

function isFinalJournalStatus(status: JournalStatus): boolean {
  return ["succeeded", "failed", "cancelled", "rejected"].includes(status);
}

function assertNoUnresolvedJournalEntries(
  journalPath: string,
  journal: Journal,
): void {
  const unresolved = journal.entries.filter(
    (entry) => !isFinalJournalStatus(entry.status),
  );
  if (unresolved.length > 0) {
    throw new Error(
      `${journalPath} contains ${unresolved.length} unresolved mutation(s); reconcile them before creating another write`,
    );
  }
}

function waitForOperationDelay(operation: OperationView): number {
  if (operation.next_reconcile_at) {
    const next = Date.parse(operation.next_reconcile_at);
    if (!Number.isNaN(next)) {
      return Math.min(5000, Math.max(500, next - Date.now()));
    }
  }
  return 2000;
}

async function followOperation(
  client: PerfloClient,
  initial: OperationView,
  timeout: number,
  wait: typeof sleep = sleep,
  acknowledge: typeof requireInput = requireInput,
): Promise<OperationView> {
  const deadline = Date.now() + timeout;
  let operation = initial;
  const expectedOperation = { id: initial.id, kind: initial.kind };
  requireOperationContinuity(expectedOperation, operation);
  let openedActionUrl: string | undefined;

  while (Date.now() < deadline) {
    if (
      ["succeeded", "failed", "cancelled", "indeterminate"].includes(
        operation.state,
      )
    ) {
      return operation;
    }
    if (operation.state === "requires_action") {
      const action = operation.action_required;
      if (!action) {
        throw new Error(`operation ${operation.id} requires an absent action`);
      }
      const expiresAt = action.expires_at
        ? Date.parse(action.expires_at)
        : undefined;
      if (
        action.kind !== "grant_approval" ||
        expiresAt === undefined ||
        Number.isNaN(expiresAt) ||
        Date.now() >= expiresAt ||
        typeof action.poll_after_ms !== "number" ||
        !Number.isFinite(action.poll_after_ms) ||
        action.poll_after_ms <= 0
      ) {
        throw new Error(`operation ${operation.id} has an invalid action`);
      }
      const url = requireTrustedAppUrl(action.url);
      if (openedActionUrl !== url.href) {
        console.log(`\nApprove operation ${operation.id} at:\n${url}\n`);
        await acknowledge("Press Enter after completing the browser action: ");
        openedActionUrl = url.href;
      }
      const actionDeadline = Math.min(deadline, expiresAt);
      await wait(
        boundedDelay(Math.max(500, action.poll_after_ms), actionDeadline),
      );
      if (Date.now() >= expiresAt) {
        throw new Error(`operation ${operation.id} browser action expired`);
      }
      if (Date.now() >= deadline) {
        break;
      }
      const polled = await raw(() =>
        pollOperationApproval({
          client,
          path: { operation_id: operation.id },
          signal: deadlineSignal(deadline),
        }),
      );
      if (polled.error !== undefined || polled.data === undefined) {
        throw new Error(
          `operation approval poll failed: ${describeError(polled.error, polled.response)}`,
        );
      }
      requireOperationContinuity(expectedOperation, polled.data);
      operation = polled.data;
      continue;
    }
    await wait(boundedDelay(waitForOperationDelay(operation), deadline));
    if (Date.now() >= deadline) {
      break;
    }
    const read = await raw(() =>
      getOperation({
        client,
        path: { operation_id: operation.id },
        signal: deadlineSignal(deadline),
      }),
    );
    if (read.error !== undefined || read.data === undefined) {
      throw new Error(
        `operation read failed: ${describeError(read.error, read.response)}`,
      );
    }
    requireOperationContinuity(expectedOperation, read.data);
    operation = read.data;
  }
  throw new Error(
    `operation ${operation.id} remained ${operation.state} after ${timeout} ms`,
  );
}

function expectedOperationKind(
  action: string,
): OperationView["kind"] | undefined {
  return Object.hasOwn(MUTATION_CONTRACTS, action)
    ? MUTATION_CONTRACTS[action as MutationAction].operationKind
    : undefined;
}

function updateJournalFromOperation(
  entry: JournalEntry,
  operation: OperationView,
): void {
  entry.operation_id = operation.id;
  entry.status =
    operation.state === "succeeded"
      ? "succeeded"
      : operation.state === "failed"
        ? "failed"
        : operation.state === "cancelled"
          ? "cancelled"
          : operation.state === "indeterminate"
            ? "indeterminate"
            : "submitted";
  entry.updated_at = new Date().toISOString();
}

function bindSubmittedOperation(
  entry: JournalEntry,
  operation: OperationView,
): void {
  if (typeof operation.id === "string" && operation.id.length > 0) {
    entry.response_operation_id = operation.id;
  }
  requireMatchingOperation(entry, operation);
  entry.operation_id = operation.id;
  entry.status = "submitted";
  entry.updated_at = new Date().toISOString();
}

function requireMatchingOperation(
  entry: JournalEntry,
  operation: OperationView,
  requestedOperationId?: string,
): void {
  const validationError = requireOperation(operation);
  if (validationError) {
    throw new Error(validationError);
  }
  if (
    requestedOperationId !== undefined &&
    operation.id !== requestedOperationId
  ) {
    throw new Error(
      `operation read returned ${operation.id}, expected ${requestedOperationId}`,
    );
  }
  const expectedKind = expectedOperationKind(entry.action);
  if (!expectedKind || operation.kind !== expectedKind) {
    throw new Error(
      `operation ${operation.id} kind ${operation.kind} does not match ${entry.action}`,
    );
  }
  if (!entry.submission_started_at) {
    throw new Error(
      `journal entry ${entry.id} never recorded financial-request dispatch`,
    );
  }
  const operationCreatedAt = Date.parse(operation.created_at);
  const submissionStartedAt = Date.parse(entry.submission_started_at);
  if (
    Number.isNaN(operationCreatedAt) ||
    Number.isNaN(submissionStartedAt) ||
    operationCreatedAt < submissionStartedAt - 5 * 60_000 ||
    operationCreatedAt > submissionStartedAt + 5 * 60_000
  ) {
    throw new Error(
      `operation ${operation.id} was not created during journal entry ${entry.id}`,
    );
  }
}

async function reconcileJournal(
  client: PerfloClient,
  journalContext: JournalContext,
  operationTimeoutMs: number,
  reconciliation: ReconciliationConfig,
  options: {
    confirm?: typeof requirePhrase;
    enabled?: boolean;
  } = {},
): Promise<void> {
  if (!(options.enabled ?? argv.has("--reconcile"))) {
    return;
  }
  const confirm = options.confirm ?? requirePhrase;
  if (!terminal && confirm === requirePhrase) {
    throw new Error("--reconcile requires an interactive terminal");
  }
  const journalPath =
    process.env.PERFLO_LIVE_JOURNAL?.trim() || DEFAULT_JOURNAL_PATH;
  await withJournalLock(journalPath, async () => {
    const journal = await loadJournal(journalPath, journalContext);
    let unresolved = journal.entries.filter(
      (entry) => !isFinalJournalStatus(entry.status),
    );
    const neverDispatched = unresolved.filter(
      (entry) => entry.submission_started_at === undefined,
    );
    for (const entry of neverDispatched) {
      entry.status = "rejected";
      entry.updated_at = new Date().toISOString();
      record(
        "PASS",
        `reconcile ${entry.id}`,
        "journal proves the financial request was not dispatched",
      );
    }
    if (neverDispatched.length > 0) {
      await saveJournal(journalPath, journal);
      unresolved = journal.entries.filter(
        (entry) => !isFinalJournalStatus(entry.status),
      );
    }
    if (reconciliation.kind !== "none") {
      const { entryId } = reconciliation;
      const entry = journal.entries.find(
        (candidate) => candidate.id === entryId,
      );
      if (!entry) {
        throw new Error(`no journal entry has ID ${entryId}`);
      }
      if (reconciliation.kind === "operation") {
        const { operationId } = reconciliation;
        if (entry.operation_id && entry.operation_id !== operationId) {
          throw new Error(
            `journal entry ${entry.id} is bound to operation ${entry.operation_id}, not ${operationId}`,
          );
        }
        if (entry.operation_id === operationId) {
          record(
            "PASS",
            `reconcile ${entry.id}`,
            `operation ${operationId} was already attached`,
          );
        } else if (isFinalJournalStatus(entry.status)) {
          throw new Error(
            `terminal journal entry ${entry.id} cannot attach operation ${operationId}`,
          );
        } else {
          console.log(
            `\nUnresolved request ${entry.id}:\n${JSON.stringify(redactMutationBody(entry.body), null, 2)}`,
          );
          const read = await raw(() =>
            getOperation({
              client,
              path: { operation_id: operationId },
              signal: AbortSignal.timeout(operationTimeoutMs),
            }),
          );
          if (read.error !== undefined || read.data === undefined) {
            throw new Error(
              `support-verified operation read failed: ${describeError(read.error, read.response)}`,
            );
          }
          requireMatchingOperation(entry, read.data, operationId);
          await confirm(
            `Bind the support-verified operation to journal entry ${entry.id}.`,
            `ATTACH ${read.data.id} TO ${entry.id}`,
          );
          updateJournalFromOperation(entry, read.data);
          await saveJournal(journalPath, journal);
          if (isFinalJournalStatus(entry.status)) {
            record(
              "PASS",
              `reconcile ${entry.id}`,
              `${read.data.state}, operation ${read.data.id}`,
            );
          }
        }
      } else {
        if (entry.operation_id) {
          throw new Error(
            `journal entry ${entry.id} is already bound to operation ${entry.operation_id}`,
          );
        } else if (entry.status === "rejected") {
          record(
            "PASS",
            `reconcile ${entry.id}`,
            "no-operation result was already recorded",
          );
        } else if (isFinalJournalStatus(entry.status)) {
          throw new Error(
            `terminal journal entry ${entry.id} cannot record a no-operation result`,
          );
        } else {
          console.log(
            `\nUnresolved request ${entry.id}:\n${JSON.stringify(redactMutationBody(entry.body), null, 2)}`,
          );
          await confirm(
            "Only continue after Perflo support proves that the request created no operation.",
            `RESOLVE ${entry.id} AS NO OPERATION`,
          );
          entry.status = "rejected";
          entry.updated_at = new Date().toISOString();
          await saveJournal(journalPath, journal);
          record(
            "PASS",
            `reconcile ${entry.id}`,
            "support verified that no operation exists",
          );
        }
      }
    }

    unresolved = journal.entries.filter(
      (entry) => !isFinalJournalStatus(entry.status),
    );
    if (unresolved.length === 0) {
      if (reconciliation.kind === "none") {
        record("PASS", "mutation reconciliation", "no unresolved entries");
      }
      return;
    }
    const missingOperation = unresolved.filter((entry) => !entry.operation_id);
    if (missingOperation.length > 0) {
      const history = await raw(() =>
        listOperations({
          client,
          query: { limit: 200 },
          signal: AbortSignal.timeout(operationTimeoutMs),
        }),
      );
      const historyValidation =
        history.data === undefined
          ? "success response omitted its required body"
          : requireOperationsArray(history.data);
      const historyRows =
        historyValidation === undefined && history.data !== undefined
          ? history.data
          : [];
      if (
        history.error !== undefined ||
        history.data === undefined ||
        historyValidation !== undefined
      ) {
        record(
          "FAIL",
          "operation history reconciliation",
          history.error !== undefined
            ? describeError(history.error, history.response)
            : historyValidation,
        );
      } else {
        record(
          "PASS",
          "operation history reconciliation",
          `${historyRows.length} recent operations inspected`,
        );
      }
      for (const entry of missingOperation) {
        const kind = expectedOperationKind(entry.action);
        const candidates = historyRows
          .filter((operation) => operation.kind === kind)
          .map((operation) => operation.id);
        record(
          "FAIL",
          `journal entry ${entry.id}`,
          `has no operation ID; ask support to verify idempotency key ${entry.idempotency_key}${
            entry.response_operation_id
              ? `; untrusted response ID: ${entry.response_operation_id}`
              : ""
          }${
            candidates.length
              ? `; same-kind recent operations: ${candidates.join(", ")}`
              : ""
          }`,
        );
      }
    }

    for (const entry of unresolved) {
      const operationIdForEntry = entry.operation_id;
      if (!operationIdForEntry) {
        continue;
      }
      const read = await raw(() =>
        getOperation({
          client,
          path: { operation_id: operationIdForEntry },
          signal: AbortSignal.timeout(operationTimeoutMs),
        }),
      );
      if (read.error !== undefined || read.data === undefined) {
        record(
          "FAIL",
          `reconcile ${entry.id}`,
          describeError(read.error, read.response),
        );
        continue;
      }
      try {
        requireMatchingOperation(entry, read.data, operationIdForEntry);
        const settled = await followOperation(
          client,
          read.data,
          operationTimeoutMs,
        );
        updateJournalFromOperation(entry, settled);
        await saveJournal(journalPath, journal);
        record(
          isFinalJournalStatus(entry.status) ? "PASS" : "FAIL",
          `reconcile ${entry.id}`,
          `${settled.state}, operation ${settled.id}`,
        );
      } catch (error) {
        record("FAIL", `reconcile ${entry.id}`, describeError(error));
      }
    }
  });
}

function createJournalEntry(
  action: MutationAction,
  path: string,
  body: unknown,
  confirmationPayload?: Record<string, unknown>,
): JournalEntry {
  const now = new Date().toISOString();
  return {
    action,
    body,
    ...(confirmationPayload
      ? { confirmation_payload: confirmationPayload }
      : {}),
    created_at: now,
    id: randomUUID(),
    idempotency_key: randomUUID(),
    method: "POST",
    path,
    status: "planned",
    updated_at: now,
  };
}

class JournalPersistenceError extends Error {
  constructor(cause: unknown) {
    super(`journal persistence failed: ${describeError(cause)}`, { cause });
  }
}

async function dispatchAfterJournal<T>(
  journalPath: string,
  journal: Journal,
  entry: JournalEntry,
  dispatch: () => PromiseLike<T>,
  persist: typeof saveJournal = saveJournal,
): Promise<T> {
  entry.submission_started_at = new Date().toISOString();
  entry.updated_at = entry.submission_started_at;
  try {
    await persist(journalPath, journal);
  } catch (error) {
    throw new JournalPersistenceError(error);
  }
  return await dispatch();
}

async function runJournaledMutation(
  options: JournaledMutationOptions,
): Promise<void> {
  const {
    action,
    body,
    client,
    journal,
    journalPath,
    label,
    operationTimeoutMs,
    path,
  } = options;
  const confirmationPayload = options.confirmationPayload;
  assertNoUnresolvedJournalEntries(journalPath, journal);
  console.log(
    `\n${label} request:\n${JSON.stringify(redactMutationBody({ body, method: "POST", path }), null, 2)}`,
  );
  await (options.confirm ?? requirePhrase)(
    "This operation can change live state or move real money.",
    `RUN ${label}`,
  );
  if (confirmationPayload !== undefined) {
    requireFreshCustomerToken(options.customerToken);
  }

  const entry = createJournalEntry(action, path, body, confirmationPayload);
  journal.entries.push(entry);
  await saveJournal(journalPath, journal);

  let confirmationIntentId: string | undefined;
  if (confirmationPayload !== undefined) {
    if (!isConfirmationAction(action)) {
      throw new TypeError(`${action} is not a confirmation-intent action`);
    }
    const confirmed = await raw(() =>
      createConfirmationIntent({
        body: { action, payload: confirmationPayload },
        client,
        signal: AbortSignal.timeout(operationTimeoutMs),
      }),
    );
    if (
      confirmed.error !== undefined ||
      confirmed.data === undefined ||
      typeof confirmed.data.id !== "string" ||
      confirmed.data.id.length === 0
    ) {
      entry.status = "rejected";
      entry.updated_at = new Date().toISOString();
      await saveJournal(journalPath, journal);
      record(
        "FAIL",
        `${label} confirmation`,
        describeError(confirmed.error, confirmed.response),
      );
      return;
    }
    confirmationIntentId = confirmed.data.id;
    entry.confirmation_intent_id = confirmationIntentId;
    entry.status = "confirmed";
    entry.updated_at = new Date().toISOString();
    await saveJournal(journalPath, journal);
    record("PASS", `${label} confirmation`, "confirmed");
  }

  const submissionDeadline = Date.now() + operationTimeoutMs;
  const submitted = await raw(() =>
    dispatchAfterJournal(journalPath, journal, entry, () => {
      const dispatch = {
        idempotencyKey: entry.idempotency_key,
        signal: deadlineSignal(submissionDeadline),
      };
      if (options.confirmationPayload === undefined) {
        return options.send(dispatch);
      }
      if (!confirmationIntentId) {
        throw new Error("confirmed mutation has no confirmation intent ID");
      }
      return options.send({ ...dispatch, confirmationIntentId });
    }),
  );
  if (submitted.error !== undefined || submitted.data === undefined) {
    if (submitted.error instanceof JournalPersistenceError) {
      entry.status = "rejected";
      entry.updated_at = new Date().toISOString();
      await saveJournal(journalPath, journal);
      record("FAIL", label, submitted.error.message);
      return;
    }
    const rejected = isDefinitiveSubmissionRejection(
      submitted.error,
      submitted.response,
    );
    entry.status = rejected ? "rejected" : "unresolved";
    entry.updated_at = new Date().toISOString();
    await saveJournal(journalPath, journal);
    record(
      "FAIL",
      label,
      `${describeError(submitted.error, submitted.response)}; ${
        rejected
          ? "nothing submitted"
          : "do not retry; reconcile the journaled request"
      }`,
    );
    return;
  }

  try {
    bindSubmittedOperation(entry, submitted.data);
  } catch (error) {
    entry.status = "unresolved";
    entry.updated_at = new Date().toISOString();
    await saveJournal(journalPath, journal);
    record(
      "FAIL",
      label,
      `${describeError(error)}; response evidence kept for reconciliation`,
    );
    return;
  }
  await saveJournal(journalPath, journal);

  let settled: OperationView;
  try {
    settled = await followOperation(
      client,
      submitted.data,
      Math.max(1, submissionDeadline - Date.now()),
    );
  } catch (error) {
    entry.status = "unresolved";
    entry.updated_at = new Date().toISOString();
    await saveJournal(journalPath, journal);
    record("FAIL", label, `${describeError(error)}; do not resubmit`);
    return;
  }

  updateJournalFromOperation(entry, settled);
  await saveJournal(journalPath, journal);
  record(
    settled.state === "succeeded" ? "PASS" : "FAIL",
    label,
    `${settled.state}, operation ${settled.id}`,
  );
}

async function runCardReveal(
  client: PerfloClient,
  customerToken: string,
  cardId: string,
): Promise<void> {
  requireFreshCustomerToken(customerToken);
  await requirePhrase(
    `Create a hosted reveal for card ${cardId}?`,
    "REVEAL CARD",
  );
  const payload = { card_id: cardId };
  const confirmed = await raw(() =>
    createConfirmationIntent({
      body: { action: "card.reveal", payload },
      client,
    }),
  );
  if (
    confirmed.error !== undefined ||
    confirmed.data === undefined ||
    typeof confirmed.data.id !== "string" ||
    confirmed.data.id.length === 0
  ) {
    record(
      "FAIL",
      "card reveal confirmation",
      describeError(confirmed.error, confirmed.response),
    );
    return;
  }
  const confirmation = confirmed.data;
  const revealed = await raw(() =>
    cardRevealSession({
      client,
      headers: { "Confirmation-Intent-ID": confirmation.id },
      path: { card_id: cardId },
    }),
  );
  if (revealed.error !== undefined || revealed.data === undefined) {
    record(
      "FAIL",
      "card reveal session",
      describeError(revealed.error, revealed.response),
    );
    return;
  }
  const actionError = requireCardRevealAction(revealed.data);
  if (actionError) {
    record("FAIL", "card reveal session", actionError);
    return;
  }
  const url = requireTrustedAppUrl(revealed.data.url);
  if (Date.now() >= Date.parse(revealed.data.expires_at as string)) {
    record("FAIL", "card reveal session", "browser action expired");
    return;
  }
  record("PASS", "card reveal session", "trusted hosted action created");
  console.log(`Open the one-time card reveal URL in your browser:\n${url}\n`);
}

async function runMutations(
  client: PerfloClient,
  customerToken: string,
  state: OnboardingView,
  journalContext: JournalContext,
  fixtures: MutationFixtures,
  operationTimeoutMs: number,
): Promise<void> {
  if (!argv.has("--mutations")) {
    record("SKIP", "live mutations", "enable with --mutations");
    return;
  }
  if (!terminal) {
    throw new Error("--mutations requires an interactive terminal");
  }
  if (state.perflo_connection !== "connected") {
    throw new Error("--mutations requires a connected Perflo account");
  }

  const {
    beneficiary,
    cardAction,
    cardCreate,
    mandate,
    mandateExecution,
    beneficiaryGrant,
    purchase,
    revealCardId,
    transfer,
    withdrawal,
  } = fixtures;
  const configured = [
    beneficiary,
    cardCreate,
    cardAction,
    mandate,
    mandateExecution,
    beneficiaryGrant,
    purchase,
    withdrawal,
    transfer,
    revealCardId,
  ].some(Boolean);
  if (!configured) {
    record("SKIP", "live mutations", "no PERFLO_LIVE_* scenario is configured");
    return;
  }

  const journalPath =
    process.env.PERFLO_LIVE_JOURNAL?.trim() || DEFAULT_JOURNAL_PATH;
  await withJournalLock(journalPath, async () => {
    const journal = await loadJournal(journalPath, journalContext);
    assertNoUnresolvedJournalEntries(journalPath, journal);

    if (beneficiary) {
      if (!state.capabilities.beneficiary_create) {
        record("SKIP", "beneficiary create", "capability unavailable");
      } else {
        await runJournaledMutation({
          action: "beneficiary.create",
          body: beneficiary,
          client,
          journal,
          journalPath,
          label: "beneficiary create",
          operationTimeoutMs,
          path: mutationPath("beneficiary.create"),
          send: ({ idempotencyKey, signal }) =>
            createBeneficiary({
              body: beneficiary,
              client,
              headers: { "Idempotency-Key": idempotencyKey },
              signal,
            }),
        });
      }
    }

    if (cardCreate) {
      if (!state.capabilities.card_create) {
        record("SKIP", "card create", "capability unavailable");
      } else {
        await runJournaledMutation({
          action: "card.create",
          body: cardCreate,
          client,
          confirmationPayload: cardCreate,
          customerToken,
          journal,
          journalPath,
          label: "card create",
          operationTimeoutMs,
          path: mutationPath("card.create"),
          send: ({ confirmationIntentId, idempotencyKey, signal }) =>
            createCard({
              body: cardCreate,
              client,
              headers: {
                "Confirmation-Intent-ID": confirmationIntentId,
                "Idempotency-Key": idempotencyKey,
              },
              signal,
            }),
        });
      }
    }

    if (cardAction) {
      if (!state.capabilities.card_lifecycle) {
        record("SKIP", `card ${cardAction.action}`, "capability unavailable");
      } else {
        const payload = { card_id: cardAction.card_id };
        const sendCardAction = ({
          confirmationIntentId,
          idempotencyKey,
          signal,
        }: MutationDispatch & { confirmationIntentId: string }) => {
          const options = {
            client,
            headers: {
              "Confirmation-Intent-ID": confirmationIntentId,
              "Idempotency-Key": idempotencyKey,
            },
            path: { card_id: cardAction.card_id },
            signal,
          };
          return cardAction.action === "freeze"
            ? freezeCard(options)
            : unfreezeCard(options);
        };
        await runJournaledMutation({
          action: `card.${cardAction.action}`,
          body: null,
          client,
          confirmationPayload: payload,
          customerToken,
          journal,
          journalPath,
          label: `card ${cardAction.action}`,
          operationTimeoutMs,
          path: mutationPath(`card.${cardAction.action}`, cardAction.card_id),
          send: sendCardAction,
        });
      }
    }

    if (revealCardId) {
      if (!state.capabilities.card_reveal) {
        record("SKIP", "card reveal session", "capability unavailable");
      } else {
        assertNoUnresolvedJournalEntries(journalPath, journal);
        await runCardReveal(client, customerToken, revealCardId);
      }
    }

    if (mandate) {
      const mandateAvailable =
        state.capabilities.mandates &&
        (mandate.kind !== "service_purchase" ||
          state.capabilities.service_mandates);
      if (!mandateAvailable) {
        record("SKIP", "mandate create", "capability unavailable");
      } else {
        await runJournaledMutation({
          action: "mandate.create",
          body: mandate,
          client,
          confirmationPayload: mandate,
          customerToken,
          journal,
          journalPath,
          label: "mandate create",
          operationTimeoutMs,
          path: mutationPath("mandate.create"),
          send: ({ confirmationIntentId, idempotencyKey, signal }) =>
            createMandate({
              body: mandate,
              client,
              headers: {
                "Confirmation-Intent-ID": confirmationIntentId,
                "Idempotency-Key": idempotencyKey,
              },
              signal,
            }),
        });
      }
    }

    if (mandateExecution) {
      if (!state.capabilities.mandates) {
        record("SKIP", "mandate execution", "capability unavailable");
      } else {
        const payload = {
          mandate_id: mandateExecution.mandate_id,
          ...mandateExecution.body,
        };
        await runJournaledMutation({
          action: "mandate.execute",
          body: mandateExecution.body,
          client,
          confirmationPayload: payload,
          customerToken,
          journal,
          journalPath,
          label: "mandate execution",
          operationTimeoutMs,
          path: mutationPath("mandate.execute", mandateExecution.mandate_id),
          send: ({ confirmationIntentId, idempotencyKey, signal }) =>
            executeMandate({
              body: mandateExecution.body,
              client,
              headers: {
                "Confirmation-Intent-ID": confirmationIntentId,
                "Idempotency-Key": idempotencyKey,
              },
              path: { mandate_id: mandateExecution.mandate_id },
              signal,
            }),
        });
      }
    }

    if (beneficiaryGrant) {
      if (!state.capabilities.mandates) {
        record("SKIP", "beneficiary grant payment", "capability unavailable");
      } else {
        const payload = {
          grant_id: beneficiaryGrant.grant_id,
          ...beneficiaryGrant.body,
        };
        await runJournaledMutation({
          action: "beneficiary_grant.spend",
          body: beneficiaryGrant.body,
          client,
          confirmationPayload: payload,
          customerToken,
          journal,
          journalPath,
          label: "beneficiary grant payment",
          operationTimeoutMs,
          path: mutationPath(
            "beneficiary_grant.spend",
            beneficiaryGrant.grant_id,
          ),
          send: ({ confirmationIntentId, idempotencyKey, signal }) =>
            spendBeneficiaryGrant({
              body: beneficiaryGrant.body,
              client,
              headers: {
                "Confirmation-Intent-ID": confirmationIntentId,
                "Idempotency-Key": idempotencyKey,
              },
              path: { grant_id: beneficiaryGrant.grant_id },
              signal,
            }),
        });
      }
    }

    if (purchase) {
      if (!state.capabilities.purchases) {
        record("SKIP", "service purchase", "capability unavailable");
      } else {
        await runJournaledMutation({
          action: "purchase.create",
          body: purchase,
          client,
          confirmationPayload: purchase,
          customerToken,
          journal,
          journalPath,
          label: "service purchase",
          operationTimeoutMs,
          path: mutationPath("purchase.create"),
          send: ({ confirmationIntentId, idempotencyKey, signal }) =>
            createPurchase({
              body: purchase,
              client,
              headers: {
                "Confirmation-Intent-ID": confirmationIntentId,
                "Idempotency-Key": idempotencyKey,
              },
              signal,
            }),
        });
      }
    }

    if (withdrawal) {
      if (!state.capabilities.spending_withdrawals) {
        record("SKIP", "spending withdrawal", "capability unavailable");
      } else {
        await runJournaledMutation({
          action: "spending_withdrawal.create",
          body: withdrawal,
          client,
          confirmationPayload: withdrawal,
          customerToken,
          journal,
          journalPath,
          label: "spending withdrawal",
          operationTimeoutMs,
          path: mutationPath("spending_withdrawal.create"),
          send: ({ confirmationIntentId, idempotencyKey, signal }) =>
            createSpendingWithdrawal({
              body: withdrawal,
              client,
              headers: {
                "Confirmation-Intent-ID": confirmationIntentId,
                "Idempotency-Key": idempotencyKey,
              },
              signal,
            }),
        });
      }
    }

    if (transfer) {
      if (!state.capabilities.quotes || !state.capabilities.transfers) {
        record("SKIP", "transfer", "quote or transfer capability unavailable");
      } else {
        const quote = await check(
          "transfer execution quote",
          () => createQuote({ body: transfer, client }),
          (data) => requireTransferQuote(data, transfer),
        );
        if (quote) {
          console.log(`\nTransfer quote:\n${JSON.stringify(quote, null, 2)}`);
          const body = { quote_id: quote.id };
          await runJournaledMutation({
            action: "transfer.create",
            body,
            client,
            confirmationPayload: body,
            customerToken,
            journal,
            journalPath,
            label: "transfer",
            operationTimeoutMs,
            path: mutationPath("transfer.create"),
            send: ({ confirmationIntentId, idempotencyKey, signal }) =>
              createTransfer({
                body,
                client,
                headers: {
                  "Confirmation-Intent-ID": confirmationIntentId,
                  "Idempotency-Key": idempotencyKey,
                },
                signal,
              }),
          });
        }
      }
    }
  });
}

function printSummary(): void {
  const counts = { FAIL: 0, PASS: 0, SKIP: 0 };
  for (const state of checks) {
    counts[state] += 1;
  }
  console.log(
    `\nSummary: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.SKIP} skipped`,
  );
  if (counts.FAIL > 0) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (argv.has("--help")) {
    usage();
    return;
  }
  const knownArguments = new Set([
    "--help",
    "--kyc-session",
    "--mutations",
    "--no-connect",
    "--public-only",
    "--quotes",
    "--reconcile",
    "--unlock",
    "--webhook",
  ]);
  const unknown = [...argv].filter((argument) => !knownArguments.has(argument));
  if (unknown.length > 0) {
    throw new TypeError(`unknown option: ${unknown.join(", ")}`);
  }
  if (argv.has("--unlock")) {
    if (argv.size !== 1) {
      throw new TypeError("--unlock cannot run with another option");
    }
    await unlockJournal();
    return;
  }
  if (argv.has("--public-only") && argv.size !== 1) {
    throw new TypeError("--public-only cannot run with another option");
  }
  if (
    argv.has("--reconcile") &&
    ["--kyc-session", "--mutations", "--quotes", "--webhook"].some((option) =>
      argv.has(option),
    )
  ) {
    throw new TypeError(
      "--reconcile cannot run with --kyc-session, --mutations, --quotes, or --webhook",
    );
  }
  const configuredBaseUrl =
    process.env.PERFLO_API_BASE_URL?.trim() || undefined;
  const apiBaseUrl = requireSafeApiBaseUrl(configuredBaseUrl);
  const requestTimeoutMs = positiveIntegerEnv(
    "PERFLO_LIVE_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const liveConfig = argv.has("--public-only") ? undefined : readLiveConfig();
  const apiOrigin = apiBaseUrl.origin;
  const clientOptions = {
    ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
    fetch: boundedFetch(requestTimeoutMs),
    idempotencyKeyFactory: randomUUID,
  };
  const publicClient = createPerfloClient(clientOptions);
  const publicData = await check(
    "public config",
    () => publicConfig({ client: publicClient }),
    requirePublicConfig,
  );
  if (!publicData) {
    return;
  }
  if (!liveConfig) {
    return;
  }

  const authorized = await authorizeDevice(publicClient);
  const customerClient = createPerfloClient({
    ...clientOptions,
    token: authorized.token,
  });
  const identity = await check(
    "customer identity",
    () => getIdentity({ client: customerClient }),
    requireIdentity,
  );
  if (!identity) {
    return;
  }
  let state = await readOnboarding(customerClient);
  requireDevicePrincipalMatch(authorized, state, identity);
  await confirmAccount(
    state.customer.email ?? authorized.email,
    identity.wallet ?? undefined,
  );
  if (state.perflo_connection !== "connected" && !argv.has("--no-connect")) {
    requireFreshCustomerToken(authorized.token);
  }
  state = await ensurePerfloConnection(
    customerClient,
    state,
    liveConfig.connectionTimeoutMs,
  );
  const journalContext: JournalContext = {
    api_origin: apiOrigin,
    customer_id: state.customer.id,
    subject: identity.subject,
  };
  const context = await runReadSweep(customerClient, state);
  if (argv.has("--reconcile")) {
    await reconcileJournal(
      customerClient,
      journalContext,
      liveConfig.operationTimeoutMs,
      liveConfig.reconciliation,
    );
    return;
  }
  await runKycSession(customerClient, state);
  await runQuotes(customerClient, state, context, liveConfig.transferQuote);
  await runWebhook(customerClient, { url: liveConfig.webhookUrl });
  await runMutations(
    customerClient,
    authorized.token,
    state,
    journalContext,
    liveConfig.mutations,
    liveConfig.operationTimeoutMs,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    record("FAIL", "live API exercise", describeError(error));
  } finally {
    terminal?.close();
    printSummary();
  }
}

export type { Journal, JournalContext, JournalEntry };
export {
  bindSubmittedOperation,
  boundedDelay,
  boundedFetch,
  check,
  checkAuthorizedDevices,
  createJournalEntry,
  describeError,
  dispatchAfterJournal,
  ensurePerfloConnection,
  followOperation,
  isJournalEntry,
  loadJournal,
  mutationPath,
  parseCardActionScenario,
  parseObjectEnvJson,
  readLiveConfig,
  reconcileJournal,
  requireAccounts,
  requireCardRevealAction,
  requireDeviceList,
  requireDevicePrincipalMatch,
  requireDisplayCurrency,
  requireExpectedId,
  requireKyc,
  requireKycAction,
  requireMandates,
  requireMatchingOperation,
  requireOnboardingData,
  requireOperationsArray,
  requirePublicConfig,
  requirePurchaseQuote,
  requireSafeApiBaseUrl,
  requireSpendingAccount,
  requireTransferQuote,
  runJournaledMutation,
  runWebhook,
  sameJournalContext,
  unlockJournal,
  withJournalLock,
};
