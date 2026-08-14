import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const repositoryRoot = resolve(
  process.env.PERFLO_SDK_RESULT_CONTRACT_ROOT ?? ".",
);
const openApiPath = resolve(repositoryRoot, "openapi.json");
const outputDirectory = resolve(
  repositoryRoot,
  process.env.PERFLO_SDK_OUTPUT ?? "src/generated",
);
const sdkPath = resolve(outputDirectory, "sdk.gen.ts");
const clientPath = resolve(outputDirectory, "client/client.gen.ts");
const clientTypesPath = resolve(outputDirectory, "client/types.gen.ts");
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

const unpatchedSdkOptions = `export type Options<
  TData extends TDataShape = TDataShape,
  ThrowOnError extends boolean = boolean,
  TResponse = unknown,
> = Options2<TData, ThrowOnError, TResponse> & {
  /**
   * You can provide a client instance returned by \`createClient()\` instead of
   * individual options. This might be also useful if you want to implement a
   * custom client.
   */
  client: Client;
  /**
   * You can pass arbitrary values through the \`meta\` object. This can be
   * used to access values that aren't defined as part of the SDK function.
   */
  meta?: keyof ClientMeta extends never ? Record<string, unknown> : ClientMeta;
};`;
const patchedSdkOptions = `type GeneratedOperationClient = Omit<Client, "getConfig" | "setConfig">;

export type Options<
  TData extends TDataShape = TDataShape,
  ThrowOnError extends boolean = boolean,
  TResponse = unknown,
> = Omit<
  Options2<TData, ThrowOnError, TResponse>,
  "parseAs" | "responseStyle"
> & {
  /**
   * You can provide a client instance returned by \`createClient()\` instead of
   * individual options. This might be also useful if you want to implement a
   * custom client.
   */
  client: GeneratedOperationClient;
  parseAs?: "json";
  responseStyle?: "fields";
  /**
   * You can pass arbitrary values through the \`meta\` object. This can be
   * used to access values that aren't defined as part of the SDK function.
   */
  meta?: keyof ClientMeta extends never ? Record<string, unknown> : ClientMeta;
};`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExportModifier(node) {
  return node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function operationName(operationId) {
  const name = operationId.replace(/[-_]+([A-Za-z0-9])/gu, (_, character) =>
    character.toUpperCase(),
  );
  if (!/^[$A-Z_a-z][$\w]*$/u.test(name)) {
    throw new TypeError(`Invalid OpenAPI operationId ${operationId}`);
  }
  return name;
}

function openApiOperationNames(document) {
  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new TypeError("OpenAPI paths must be an object");
  }
  const names = new Set();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!isRecord(pathItem)) {
      throw new TypeError(`OpenAPI path item ${path} must be an object`);
    }
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!operationMethods.has(method)) {
        continue;
      }
      if (!isRecord(operation) || typeof operation.operationId !== "string") {
        throw new TypeError(
          `OpenAPI ${method.toUpperCase()} ${path} needs operationId`,
        );
      }
      const name = operationName(operation.operationId);
      if (names.has(name)) {
        throw new TypeError(`Duplicate OpenAPI operation ${name}`);
      }
      names.add(name);
    }
  }
  if (names.size === 0) {
    throw new TypeError("OpenAPI document has no operations");
  }
  return names;
}

function parseTypeScript(filename, source) {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const message = ts.flattenDiagnosticMessageText(
      diagnostics[0].messageText,
      "\n",
    );
    throw new TypeError(`Invalid TypeScript in ${filename}: ${message}`);
  }
  return sourceFile;
}

function objectPropertyName(property) {
  if (
    "name" in property &&
    property.name !== undefined &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
  ) {
    return property.name.text;
  }
  return undefined;
}

function operationCallObject(name, declaration) {
  const initializer = declaration.initializer;
  if (initializer === undefined || !ts.isArrowFunction(initializer)) {
    throw new TypeError(
      `Generated operation ${name} must be an arrow function`,
    );
  }
  let expression = initializer.body;
  while (ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  if (!ts.isCallExpression(expression)) {
    throw new TypeError(
      `Generated operation ${name} must return a client call`,
    );
  }
  const method = expression.expression;
  if (
    !ts.isPropertyAccessExpression(method) ||
    !ts.isPropertyAccessExpression(method.expression) ||
    !ts.isIdentifier(method.expression.expression) ||
    method.expression.expression.text !== "options" ||
    method.expression.name.text !== "client" ||
    !operationMethods.has(method.name.text) ||
    expression.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(expression.arguments[0])
  ) {
    throw new TypeError(
      `Generated operation ${name} has an invalid client call`,
    );
  }
  return expression.arguments[0];
}

function patchSdk(source, expectedOperations) {
  let patched = replaceInvariant(
    source,
    unpatchedSdkOptions,
    patchedSdkOptions,
    "operation Options type",
  );
  const sourceFile = parseTypeScript(sdkPath, patched);
  const declarations = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        expectedOperations.has(declaration.name.text)
      ) {
        if (declarations.has(declaration.name.text)) {
          throw new TypeError(
            `Duplicate generated operation ${declaration.name.text}`,
          );
        }
        declarations.set(declaration.name.text, declaration);
      }
    }
  }

  const missing = [...expectedOperations].filter(
    (name) => !declarations.has(name),
  );
  if (missing.length > 0 || declarations.size !== expectedOperations.size) {
    throw new TypeError(
      `Generated SDK operation mismatch: expected ${expectedOperations.size}, found ${declarations.size}; missing ${missing.join(", ") || "none"}`,
    );
  }

  const insertions = [];
  for (const [name, declaration] of declarations) {
    const object = operationCallObject(name, declaration);
    const parseProperties = object.properties.filter(
      (property) => objectPropertyName(property) === "parseAs",
    );
    const responseProperties = object.properties.filter(
      (property) => objectPropertyName(property) === "responseStyle",
    );
    if (parseProperties.length > 1 || responseProperties.length > 1) {
      throw new TypeError(
        `Generated operation ${name} has duplicate result-contract properties`,
      );
    }
    if (parseProperties.length === 1 || responseProperties.length === 1) {
      const parseProperty = parseProperties[0];
      const responseProperty = responseProperties[0];
      if (
        parseProperty === undefined ||
        responseProperty === undefined ||
        !ts.isPropertyAssignment(parseProperty) ||
        !ts.isStringLiteral(parseProperty.initializer) ||
        parseProperty.initializer.text !== "json" ||
        !ts.isPropertyAssignment(responseProperty) ||
        !ts.isStringLiteral(responseProperty.initializer) ||
        responseProperty.initializer.text !== "fields" ||
        object.properties.at(-2) !== parseProperty ||
        object.properties.at(-1) !== responseProperty
      ) {
        throw new TypeError(
          `Generated operation ${name} must force JSON field results last`,
        );
      }
      continue;
    }
    if (
      !object.properties.some(
        (property) =>
          ts.isSpreadAssignment(property) &&
          ts.isIdentifier(property.expression) &&
          property.expression.text === "options",
      )
    ) {
      throw new TypeError(`Generated operation ${name} must spread options`);
    }
    const closingBrace = object.getEnd() - 1;
    const lineStart = patched.lastIndexOf("\n", closingBrace - 1) + 1;
    const closingIndent = patched.slice(lineStart, closingBrace);
    if (!/^\s*$/u.test(closingIndent)) {
      throw new TypeError(
        `Generated operation ${name} object must close on its own line`,
      );
    }
    const previous = patched.slice(0, closingBrace).trimEnd().at(-1);
    if (previous !== ",") {
      throw new TypeError(
        `Generated operation ${name} object must use trailing commas`,
      );
    }
    insertions.push({
      position: closingBrace,
      text: `  parseAs: "json",\n${closingIndent}  responseStyle: "fields",\n${closingIndent}`,
    });
  }

  for (const insertion of insertions.sort(
    (left, right) => right.position - left.position,
  )) {
    patched = `${patched.slice(0, insertion.position)}${insertion.text}${patched.slice(insertion.position)}`;
  }
  return patched;
}

const unpatchedEmptySuccess = `if (
          response.status === 204 ||
          response.headers.get("Content-Length") === "0"
        ) {`;
const patchedEmptySuccess = `if (response.status === 204) {`;
const unpatchedJsonSuccess = `case "json": {
            // Some servers return 200 with no Content-Length and empty body.
            // response.json() would throw; read as text and parse if non-empty.
            const text = await response.text();
            data = text ? JSON.parse(text) : {};
            break;
          }`;
const patchedJsonSuccess = `case "json":
            data = await response.json();
            break;`;
const unpatchedErrorParameter = `export type RequestResult<
  TData = unknown,
  TError = unknown,`;
const patchedErrorParameter = `export type RequestResult<
  TData = unknown,
  _TError = unknown,`;
const unpatchedFieldError = `error: TError extends Record<string, unknown>
                  ? TError[keyof TError]
                  : TError;`;
const patchedFieldError = `error: unknown;`;

function patchClient(source) {
  return replaceInvariant(
    replaceInvariant(
      source,
      unpatchedEmptySuccess,
      patchedEmptySuccess,
      "empty success handling",
    ),
    unpatchedJsonSuccess,
    patchedJsonSuccess,
    "JSON success handling",
  );
}

function patchClientTypes(source) {
  return replaceInvariant(
    replaceInvariant(
      source,
      unpatchedErrorParameter,
      patchedErrorParameter,
      "request error parameter",
    ),
    unpatchedFieldError,
    patchedFieldError,
    "field error type",
  );
}

function replaceInvariant(source, unpatched, patched, name) {
  const unpatchedCount = source.split(unpatched).length - 1;
  const patchedCount = source.split(patched).length - 1;
  if (unpatchedCount === 1 && patchedCount === 0) {
    return source.replace(unpatched, patched);
  }
  if (unpatchedCount === 0 && patchedCount === 1) {
    return source;
  }
  throw new TypeError(
    `Generated ${name} mismatch: unpatched ${unpatchedCount}, patched ${patchedCount}`,
  );
}

const document = JSON.parse(await readFile(openApiPath, "utf8"));
const expectedOperations = openApiOperationNames(document);
const [sdkSource, clientSource, clientTypesSource] = await Promise.all([
  readFile(sdkPath, "utf8"),
  readFile(clientPath, "utf8"),
  readFile(clientTypesPath, "utf8"),
]);

const patchedSdk = patchSdk(sdkSource, expectedOperations);
const patchedClient = patchClient(clientSource);
const patchedClientTypes = patchClientTypes(clientTypesSource);
await Promise.all([
  patchedSdk === sdkSource ? undefined : writeFile(sdkPath, patchedSdk),
  patchedClient === clientSource
    ? undefined
    : writeFile(clientPath, patchedClient),
  patchedClientTypes === clientTypesSource
    ? undefined
    : writeFile(clientTypesPath, patchedClientTypes),
]);

console.log(
  `Enforced JSON field results for ${expectedOperations.size} generated operations`,
);
