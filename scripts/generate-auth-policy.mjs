import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const inputPath = resolve(process.env.PERFLO_SDK_OPENAPI ?? "openapi.json");
const outputPath = resolve(
  process.env.PERFLO_SDK_OUTPUT ?? "src/generated",
  "auth-policy.gen.ts",
);
const document = JSON.parse(await readFile(inputPath, "utf8"));
const operationMethods = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);
const authentication = [];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const bearerScheme = document.components?.securitySchemes?.BearerAuth;
if (
  !isRecord(bearerScheme) ||
  bearerScheme.type !== "http" ||
  bearerScheme.scheme?.toLowerCase() !== "bearer"
) {
  throw new TypeError(
    "OpenAPI components.securitySchemes.BearerAuth must be an HTTP bearer scheme",
  );
}

function isAuthenticated(security, operation) {
  if (security === undefined) {
    return false;
  }
  if (!Array.isArray(security)) {
    throw new TypeError(`Invalid OpenAPI security for ${operation}`);
  }

  let allowsAnonymous = security.length === 0;
  for (const requirement of security) {
    if (!isRecord(requirement)) {
      throw new TypeError(
        `Invalid OpenAPI security requirement for ${operation}`,
      );
    }
    const schemes = Object.entries(requirement);
    if (schemes.length === 0) {
      allowsAnonymous = true;
    }
    for (const [scheme, scopes] of schemes) {
      if (scheme !== "BearerAuth") {
        throw new TypeError(
          `Unsupported OpenAPI security scheme ${scheme} for ${operation}`,
        );
      }
      if (
        !Array.isArray(scopes) ||
        !scopes.every((scope) => typeof scope === "string")
      ) {
        throw new TypeError(`Invalid OpenAPI security scopes for ${operation}`);
      }
    }
  }

  return !allowsAnonymous;
}

function pathPattern(path) {
  const parts = path.split(/(\{[^}]+\})/u);
  const pattern = parts
    .map((part) =>
      part.startsWith("{") && part.endsWith("}")
        ? "[^/]+"
        : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    )
    .join("");
  return `^${pattern}$`;
}

for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
  if (!isRecord(pathItem)) {
    throw new TypeError(`Invalid OpenAPI path item: ${path}`);
  }
  if (Object.hasOwn(pathItem, "$ref")) {
    throw new TypeError(`Unsupported referenced OpenAPI path item: ${path}`);
  }
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!operationMethods.has(method)) {
      continue;
    }
    if (!isRecord(operation)) {
      throw new TypeError(
        `Invalid OpenAPI operation: ${method.toUpperCase()} ${path}`,
      );
    }
    const security = Object.hasOwn(operation, "security")
      ? operation.security
      : document.security;
    authentication.push({
      authenticated: isAuthenticated(
        security,
        `${method.toUpperCase()} ${path}`,
      ),
      method: method.toUpperCase(),
      path,
      pattern: pathPattern(path),
      variables: (path.match(/\{/gu) ?? []).length,
    });
  }
}

authentication.sort(
  (left, right) =>
    left.method.localeCompare(right.method) ||
    left.variables - right.variables ||
    left.path.localeCompare(right.path),
);
const entries = authentication
  .map(
    ({ authenticated, method, pattern }) =>
      `  {
    authenticated: ${String(authenticated)},
    method: ${JSON.stringify(method)},
    pattern: new RegExp(${JSON.stringify(pattern)}),
  },`,
  )
  .join("\n");
const source = `// This file is generated from openapi.json by scripts/generate-auth-policy.mjs

const OPERATION_AUTHENTICATION: ReadonlyArray<{
  authenticated: boolean;
  method: string;
  pattern: RegExp;
}> = [
${entries}
];

export function isAuthenticatedOperation(
  method: string,
  path: string,
): boolean {
  const normalizedMethod = method.toUpperCase();
  return (
    OPERATION_AUTHENTICATION.find(
      (operation) =>
        operation.method === normalizedMethod && operation.pattern.test(path),
    )?.authenticated ?? true
  );
}
`;

await writeFile(outputPath, source);
