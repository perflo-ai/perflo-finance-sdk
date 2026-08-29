// Shared OpenAPI document validation and traversal helpers belong here.

export const httpMethods = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

const pathItemFields = new Set([
  "summary",
  "description",
  "servers",
  "parameters",
]);

function assertInlinePathItem(pathItem, path) {
  if (Object.hasOwn(pathItem, "$ref")) {
    throw new TypeError(
      `OpenAPI path item ${path} uses an unsupported reference; it must be resolved before generation`,
    );
  }
}

function isOperationPathItemKey(key, path) {
  if (httpMethods.has(key)) {
    return true;
  }
  if (pathItemFields.has(key) || key.startsWith("x-")) {
    return false;
  }
  throw new TypeError(
    `Unsupported OpenAPI path item key ${JSON.stringify(key)} for ${path}`,
  );
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function* operationEntries(document) {
  const paths = document?.paths;
  if (paths !== undefined && !isRecord(paths)) {
    throw new TypeError("OpenAPI paths must be an object");
  }
  for (const [path, pathItem] of Object.entries(paths ?? {})) {
    if (path.startsWith("x-")) {
      continue;
    }
    if (!path.startsWith("/")) {
      throw new TypeError(`Invalid OpenAPI path: ${path}`);
    }
    if (!isRecord(pathItem)) {
      throw new TypeError(`Invalid OpenAPI path item: ${path}`);
    }
    assertInlinePathItem(pathItem, path);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isOperationPathItemKey(method, path)) {
        continue;
      }
      const route = `${method.toUpperCase()} ${path}`;
      if (!isRecord(operation)) {
        throw new TypeError(`Invalid OpenAPI operation: ${route}`);
      }
      yield { method, operation, path, route };
    }
  }
}

export function requireOperations(document) {
  const operations = [...operationEntries(document)];
  if (operations.length === 0) {
    throw new TypeError("OpenAPI document has no operations");
  }
  return operations;
}

export function readAuthentication(security, operation) {
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

export function validateBearerScheme(document) {
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
}
