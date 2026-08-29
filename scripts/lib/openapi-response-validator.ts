import { createHash } from "node:crypto";
import { BASIC } from "@hyperjump/json-schema/experimental";
import {
  hasSchema,
  registerSchema,
  type Validator,
  validate,
} from "@hyperjump/json-schema/openapi-3-1";

type HttpMethod = "delete" | "get" | "patch" | "post";
type JsonRecord = Record<string, unknown>;

interface OpenApiResponse {
  $ref?: string;
  content?: Record<string, { schema?: unknown }>;
}

interface OpenApiOperation {
  responses?: Record<string, OpenApiResponse>;
}

interface OpenApiDocument {
  openapi?: string;
  paths?: Record<string, Partial<Record<HttpMethod, OpenApiOperation>>>;
}

export interface ResponseValidationInput {
  contentType: string | null;
  method: HttpMethod;
  path: string;
  status: number;
  value: unknown;
}

export interface OpenApiResponseValidator {
  documentSha256: string;
  validateResponse: (input: ResponseValidationInput) => Promise<Array<string>>;
}

const OPENAPI_SCHEMA = "https://spec.openapis.org/oas/3.1/schema-base";
const OPENAPI_DIALECT = "https://spec.openapis.org/oas/3.1/dialect/base";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointerToken(value: string): string {
  return encodeURIComponent(value.replaceAll("~", "~0").replaceAll("/", "~1"));
}

export function responseSchemaUri(
  documentUri: string,
  method: HttpMethod,
  path: string,
  status: string,
  mediaType: string,
): string {
  const tokens = [
    "paths",
    path,
    method,
    "responses",
    status,
    "content",
    mediaType,
    "schema",
  ];
  return `${documentUri}#/${tokens.map(pointerToken).join("/")}`;
}

function normalizeMediaType(value: string | null): string | undefined {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function mediaSpecificity(pattern: string, actual: string): number {
  if (pattern === actual) return 2;
  const [patternType, patternSubtype] = pattern.split("/", 2);
  const [actualType] = actual.split("/", 1);
  if (patternSubtype === "*" && patternType === actualType) return 1;
  return pattern === "*/*" ? 0 : -1;
}

function selectMediaType(
  content: Record<string, unknown>,
  actual: string | undefined,
): string | undefined {
  if (!actual) return;
  const candidates = Object.keys(content)
    .map((declared) => ({
      declared,
      score: mediaSpecificity(declared.toLowerCase(), actual),
    }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score);
  if (candidates.length > 1 && candidates[0]?.score === candidates[1]?.score) {
    throw new Error(`ambiguous response media type for ${actual}`);
  }
  return candidates[0]?.declared;
}

function selectResponse(
  responses: Record<string, OpenApiResponse>,
  status: number,
): [string, OpenApiResponse] | undefined {
  const exact = String(status);
  if (responses[exact]) return [exact, responses[exact]];
  const range = `${Math.floor(status / 100)}XX`;
  if (responses[range]) return [range, responses[range]];
  return responses.default ? ["default", responses.default] : undefined;
}

function findExternalReference(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findExternalReference(item);
      if (found) return found;
    }
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) {
    return value.$ref;
  }
  for (const child of Object.values(value)) {
    const found = findExternalReference(child);
    if (found) return found;
  }
  return;
}

function normalizeErrors(
  output: Awaited<ReturnType<Validator>>,
): Array<string> {
  if (output.valid) return [];
  if (!output.errors || output.errors.length === 0) {
    return ["response does not match the documented schema"];
  }
  return output.errors.slice(0, 12).map((error) => {
    const keyword = error.keyword.slice(
      Math.max(error.keyword.lastIndexOf("/"), error.keyword.lastIndexOf("#")) +
        1,
    );
    const hash = error.absoluteKeywordLocation.indexOf("#");
    const schemaPath =
      hash === -1 ? "#" : error.absoluteKeywordLocation.slice(hash);
    return `${error.instanceLocation} fails ${keyword} at ${schemaPath}`;
  });
}

export async function createOpenApiResponseValidator(
  source: string,
): Promise<OpenApiResponseValidator> {
  const document: unknown = JSON.parse(source);
  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new Error("OpenAPI document must contain paths");
  }
  const externalReference = findExternalReference(document);
  if (externalReference) {
    throw new Error(
      `OpenAPI document contains unsupported external reference ${externalReference}`,
    );
  }
  const documentValidation = await validate(
    OPENAPI_SCHEMA,
    document as never,
    BASIC,
  );
  const documentErrors = normalizeErrors(documentValidation);
  if (documentErrors.length > 0) {
    throw new Error(
      `OpenAPI document is invalid: ${documentErrors.join("; ")}`,
    );
  }

  const documentSha256 = createHash("sha256").update(source).digest("hex");
  const documentUri = `https://openapi.perflo.invalid/${documentSha256}/openapi.json`;
  if (!hasSchema(documentUri)) {
    registerSchema(document as never, documentUri, OPENAPI_DIALECT);
  }
  const validators = new Map<string, Promise<Validator>>();
  const validatorFor = (uri: string): Promise<Validator> => {
    let pending = validators.get(uri);
    if (!pending) {
      pending = validate(uri);
      validators.set(uri, pending);
    }
    return pending;
  };

  return {
    documentSha256,
    validateResponse: async ({ contentType, method, path, status, value }) => {
      const openapi = document as unknown as OpenApiDocument;
      const operation = openapi.paths?.[path]?.[method];
      if (!operation?.responses) {
        return [`no response contract for ${method.toUpperCase()} ${path}`];
      }
      const selected = selectResponse(operation.responses, status);
      if (!selected) return [`HTTP ${status} is not declared`];
      const [statusKey, response] = selected;
      if (response.$ref) {
        return [
          "response-object references must be resolved before validation",
        ];
      }
      const content = response.content ?? {};
      if (Object.keys(content).length === 0) {
        return value === undefined
          ? []
          : ["response body is present but the contract declares none"];
      }
      const selectedMediaType = selectMediaType(
        content,
        normalizeMediaType(contentType),
      );
      if (!selectedMediaType) {
        return [
          `Content-Type ${normalizeMediaType(contentType) ?? "absent"} is not declared`,
        ];
      }
      if (value === undefined) return ["required response body is absent"];
      if (!content[selectedMediaType]?.schema) return [];
      const schemaUri = responseSchemaUri(
        documentUri,
        method,
        path,
        statusKey,
        selectedMediaType,
      );
      const validator = await validatorFor(schemaUri);
      return normalizeErrors(validator(value as never, BASIC));
    },
  };
}
