import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  readAuthentication,
  requireOperations,
  validateBearerScheme,
} from "./lib/openapi.mjs";

const inputPath = resolve(process.env.PERFLO_SDK_OPENAPI ?? "openapi.json");
const outputPath = resolve(
  process.env.PERFLO_SDK_OUTPUT ?? "src/generated",
  "auth-policy.gen.ts",
);
const document = JSON.parse(await readFile(inputPath, "utf8"));
const authentication = [];

// Validate BearerAuth even when no operation requires authentication.
validateBearerScheme(document);

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

for (const { method, operation, path, route } of requireOperations(document)) {
  const security = Object.hasOwn(operation, "security")
    ? operation.security
    : document.security;
  authentication.push({
    authenticated: readAuthentication(security, route),
    method: method.toUpperCase(),
    path,
    pattern: pathPattern(path),
    variables: (path.match(/\{/gu) ?? []).length,
  });
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
