import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const REFERENCE_START_MARKER = "{/* SDK_REFERENCE_START */}";
export const REFERENCE_END_MARKER = "{/* SDK_REFERENCE_END */}";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
const requestGroupNames = ["body", "path", "query", "headers"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExportModifier(node) {
  return node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
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

function propertyName(node) {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  return undefined;
}

function typeReferenceName(node) {
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) {
    return undefined;
  }
  return node.typeName.text;
}

function identifierTypeName(node, context) {
  const name = typeReferenceName(node);
  if (name === undefined) {
    throw new TypeError(`${context} must be a named type reference`);
  }
  return name;
}

function operationName(operationId) {
  const name = operationId.replace(/[-_]+([A-Za-z0-9])/gu, (_, character) =>
    character.toUpperCase(),
  );
  if (!/^[$A-Z_a-z][$\w]*$/u.test(name)) {
    throw new TypeError(
      `OpenAPI operationId ${JSON.stringify(operationId)} does not map to a TypeScript identifier`,
    );
  }
  return name;
}

function readAuthentication(document, security, operation) {
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

  const bearerScheme = document.components?.securitySchemes?.BearerAuth;
  if (
    !allowsAnonymous &&
    (!isRecord(bearerScheme) ||
      bearerScheme.type !== "http" ||
      bearerScheme.scheme?.toLowerCase() !== "bearer")
  ) {
    throw new TypeError(
      "OpenAPI components.securitySchemes.BearerAuth must be an HTTP bearer scheme",
    );
  }
  return !allowsAnonymous;
}

export function extractOpenApiOperations(document) {
  if (!isRecord(document) || !isRecord(document.paths)) {
    throw new TypeError("OpenAPI document must contain a paths object");
  }
  if (!Array.isArray(document.tags)) {
    throw new TypeError("OpenAPI document must contain a tags array");
  }

  const domainOrder = [];
  const domains = new Set();
  for (const tag of document.tags) {
    if (
      !isRecord(tag) ||
      typeof tag.name !== "string" ||
      tag.name.trim() === ""
    ) {
      throw new TypeError("Every OpenAPI tag must have a nonempty name");
    }
    if (domains.has(tag.name)) {
      throw new TypeError(`Duplicate OpenAPI tag: ${tag.name}`);
    }
    domains.add(tag.name);
    domainOrder.push(tag.name);
  }

  const operations = [];
  const operationIds = new Set();
  const operationKeys = new Set();
  for (const [path, pathItem] of Object.entries(document.paths)) {
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
      const operationLabel = `${method.toUpperCase()} ${path}`;
      if (!isRecord(operation)) {
        throw new TypeError(`Invalid OpenAPI operation: ${operationLabel}`);
      }
      if (
        typeof operation.operationId !== "string" ||
        operation.operationId === ""
      ) {
        throw new TypeError(
          `OpenAPI operation ${operationLabel} must have an operationId`,
        );
      }
      if (operationIds.has(operation.operationId)) {
        throw new TypeError(
          `Duplicate OpenAPI operationId: ${operation.operationId}`,
        );
      }
      operationIds.add(operation.operationId);
      if (
        typeof operation.summary !== "string" ||
        operation.summary.trim() === ""
      ) {
        throw new TypeError(
          `OpenAPI operation ${operationLabel} must have a summary`,
        );
      }
      if (
        !Array.isArray(operation.tags) ||
        operation.tags.length !== 1 ||
        typeof operation.tags[0] !== "string"
      ) {
        throw new TypeError(
          `OpenAPI operation ${operationLabel} must have exactly one tag`,
        );
      }
      const domain = operation.tags[0];
      if (!domains.has(domain)) {
        throw new TypeError(
          `OpenAPI operation ${operationLabel} uses undeclared tag ${domain}`,
        );
      }
      const key = `${method.toUpperCase()} ${path}`;
      if (operationKeys.has(key)) {
        throw new TypeError(`Duplicate OpenAPI operation: ${key}`);
      }
      operationKeys.add(key);
      const security = Object.hasOwn(operation, "security")
        ? operation.security
        : document.security;
      operations.push({
        authenticated: readAuthentication(document, security, operationLabel),
        domain,
        functionName: operationName(operation.operationId),
        key,
        method: method.toUpperCase(),
        operationId: operation.operationId,
        path,
        summary: operation.summary,
      });
    }
  }

  return { domainOrder, operations };
}

function objectProperties(object, context) {
  const properties = new Map();
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member)) {
      continue;
    }
    const name = propertyName(member.name);
    if (name === undefined) {
      continue;
    }
    if (properties.has(name)) {
      throw new TypeError(`${context} has duplicate ${name} properties`);
    }
    properties.set(name, member.initializer);
  }
  return properties;
}

function validateBearerSecurity(node, context) {
  if (
    !ts.isArrayLiteralExpression(node) ||
    node.elements.length !== 1 ||
    !ts.isObjectLiteralExpression(node.elements[0])
  ) {
    throw new TypeError(`${context} has malformed bearer security metadata`);
  }
  const requirement = objectProperties(node.elements[0], context);
  const scheme = requirement.get("scheme");
  const type = requirement.get("type");
  if (
    requirement.size !== 2 ||
    scheme === undefined ||
    !ts.isStringLiteral(scheme) ||
    scheme.text !== "bearer" ||
    type === undefined ||
    !ts.isStringLiteral(type) ||
    type.text !== "http"
  ) {
    throw new TypeError(`${context} has malformed bearer security metadata`);
  }
}

export function extractSdkOperations(filename, source) {
  const sourceFile = parseTypeScript(filename, source);
  const operations = [];
  const functionNames = new Set();
  const operationKeys = new Set();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !ts.isArrowFunction(declaration.initializer)
      ) {
        continue;
      }
      const arrow = declaration.initializer;
      const optionsParameter = arrow.parameters[0];
      if (
        arrow.parameters.length !== 1 ||
        optionsParameter === undefined ||
        typeReferenceName(optionsParameter.type) !== "Options"
      ) {
        continue;
      }
      const context = `Generated SDK function ${declaration.name.text}`;
      const optionsType = optionsParameter.type;
      if (
        !ts.isTypeReferenceNode(optionsType) ||
        optionsType.typeArguments?.length !== 2
      ) {
        throw new TypeError(`${context} must use Options<Data, ThrowOnError>`);
      }
      const dataType = identifierTypeName(
        optionsType.typeArguments[0],
        `${context} data type`,
      );
      if (optionsType.typeArguments[1].getText(sourceFile) !== "ThrowOnError") {
        throw new TypeError(`${context} has an invalid Options throw type`);
      }
      const returnType = arrow.type;
      if (
        typeReferenceName(returnType) !== "RequestResult" ||
        !ts.isTypeReferenceNode(returnType) ||
        returnType.typeArguments?.length !== 3
      ) {
        throw new TypeError(`${context} must return RequestResult`);
      }
      const responsesType = identifierTypeName(
        returnType.typeArguments[0],
        `${context} response type`,
      );
      const errorsType = identifierTypeName(
        returnType.typeArguments[1],
        `${context} error type`,
      );
      if (returnType.typeArguments[2].getText(sourceFile) !== "ThrowOnError") {
        throw new TypeError(
          `${context} has an invalid RequestResult throw type`,
        );
      }
      if (!ts.isCallExpression(arrow.body)) {
        throw new TypeError(`${context} must call a client method directly`);
      }
      const call = arrow.body;
      if (
        !ts.isPropertyAccessExpression(call.expression) ||
        !operationMethods.has(call.expression.name.text) ||
        !ts.isPropertyAccessExpression(call.expression.expression) ||
        call.expression.expression.name.text !== "client" ||
        !ts.isIdentifier(call.expression.expression.expression) ||
        call.expression.expression.expression.text !==
          optionsParameter.name.getText(sourceFile)
      ) {
        throw new TypeError(`${context} must call options.client.<method>`);
      }
      if (call.typeArguments?.length !== 3) {
        throw new TypeError(
          `${context} client call must have three type arguments`,
        );
      }
      const callResponses = identifierTypeName(
        call.typeArguments[0],
        `${context} client response type`,
      );
      const callErrors = identifierTypeName(
        call.typeArguments[1],
        `${context} client error type`,
      );
      if (
        callResponses !== responsesType ||
        callErrors !== errorsType ||
        call.typeArguments[2].getText(sourceFile) !== "ThrowOnError"
      ) {
        throw new TypeError(`${context} has mismatched RequestResult types`);
      }
      if (
        call.arguments.length !== 1 ||
        !ts.isObjectLiteralExpression(call.arguments[0])
      ) {
        throw new TypeError(`${context} must pass one object to the client`);
      }
      const properties = objectProperties(call.arguments[0], context);
      const url = properties.get("url");
      if (url === undefined || !ts.isStringLiteral(url)) {
        throw new TypeError(`${context} must contain one string-literal URL`);
      }
      const security = properties.get("security");
      if (security !== undefined) {
        validateBearerSecurity(security, context);
      }
      const functionName = declaration.name.text;
      const method = call.expression.name.text.toUpperCase();
      const key = `${method} ${url.text}`;
      if (functionNames.has(functionName)) {
        throw new TypeError(
          `Duplicate generated SDK function: ${functionName}`,
        );
      }
      functionNames.add(functionName);
      if (operationKeys.has(key)) {
        throw new TypeError(`Duplicate generated SDK operation: ${key}`);
      }
      operationKeys.add(key);
      operations.push({
        authenticated: security !== undefined,
        dataType,
        errorsType,
        functionName,
        key,
        method,
        path: url.text,
        responsesType,
      });
    }
  }

  return operations;
}

function validateIndexedAlias(alias, pluralName, aliasName) {
  if (!ts.isIndexedAccessTypeNode(alias.type)) {
    throw new TypeError(`${aliasName} must index ${pluralName}`);
  }
  const objectName = typeReferenceName(alias.type.objectType);
  const indexType = alias.type.indexType;
  if (
    objectName !== pluralName ||
    !ts.isTypeOperatorNode(indexType) ||
    indexType.operator !== ts.SyntaxKind.KeyOfKeyword ||
    typeReferenceName(indexType.type) !== pluralName
  ) {
    throw new TypeError(
      `${aliasName} must be ${pluralName}[keyof ${pluralName}]`,
    );
  }
}

function validateRequestType(alias, operation) {
  if (!ts.isTypeLiteralNode(alias.type)) {
    throw new TypeError(`${operation.dataType} must be an object type`);
  }
  const properties = new Map();
  for (const member of alias.type.members) {
    if (!ts.isPropertySignature(member)) {
      throw new TypeError(
        `${operation.dataType} may contain only request properties`,
      );
    }
    const name = propertyName(member.name);
    if (name === undefined) {
      throw new TypeError(`${operation.dataType} has an unsupported property`);
    }
    if (![...requestGroupNames, "url"].includes(name)) {
      throw new TypeError(
        `${operation.dataType} has unsupported property ${name}`,
      );
    }
    if (properties.has(name)) {
      throw new TypeError(
        `${operation.dataType} has duplicate property ${name}`,
      );
    }
    if (member.type === undefined) {
      throw new TypeError(`${operation.dataType}.${name} must have a type`);
    }
    properties.set(name, member);
  }

  for (const name of ["body", "path", "query", "url"]) {
    if (!properties.has(name)) {
      throw new TypeError(`${operation.dataType} is missing property ${name}`);
    }
  }
  const url = properties.get("url");
  if (
    url.questionToken !== undefined ||
    !ts.isLiteralTypeNode(url.type) ||
    !ts.isStringLiteral(url.type.literal) ||
    url.type.literal.text !== operation.path
  ) {
    throw new TypeError(
      `${operation.dataType}.url must be the literal ${JSON.stringify(operation.path)}`,
    );
  }

  const groups = [];
  for (const name of requestGroupNames) {
    const property = properties.get(name);
    if (property === undefined) {
      continue;
    }
    if (property.type.kind === ts.SyntaxKind.NeverKeyword) {
      if (property.questionToken === undefined) {
        throw new TypeError(
          `${operation.dataType}.${name} cannot be required never`,
        );
      }
      continue;
    }
    groups.push({ name, required: property.questionToken === undefined });
  }
  return groups;
}

export function extractOperationTypes(filename, source, sdkOperations) {
  const sourceFile = parseTypeScript(filename, source);
  const aliases = new Map();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isTypeAliasDeclaration(statement) ||
      !hasExportModifier(statement)
    ) {
      continue;
    }
    const name = statement.name.text;
    if (aliases.has(name)) {
      throw new TypeError(`Duplicate generated type alias: ${name}`);
    }
    aliases.set(name, statement);
  }

  for (const operation of sdkOperations) {
    if (!operation.dataType.endsWith("Data")) {
      throw new TypeError(
        `Generated SDK function ${operation.functionName} has invalid data type ${operation.dataType}`,
      );
    }
    const stem = operation.dataType.slice(0, -"Data".length);
    const expectedResponses = `${stem}Responses`;
    const expectedErrors = `${stem}Errors`;
    if (
      operation.responsesType !== expectedResponses ||
      operation.errorsType !== expectedErrors
    ) {
      throw new TypeError(
        `Generated SDK function ${operation.functionName} has mismatched operation types`,
      );
    }
    const responseType = `${stem}Response`;
    const errorType = `${stem}Error`;
    const requiredAliases = [
      operation.dataType,
      operation.responsesType,
      responseType,
      operation.errorsType,
      errorType,
    ];
    for (const name of requiredAliases) {
      if (!aliases.has(name)) {
        throw new TypeError(
          `Generated SDK function ${operation.functionName} is missing type ${name}`,
        );
      }
    }
    const responses = aliases.get(operation.responsesType);
    const errors = aliases.get(operation.errorsType);
    if (!ts.isTypeLiteralNode(responses.type)) {
      throw new TypeError(`${operation.responsesType} must be an object type`);
    }
    if (!ts.isTypeLiteralNode(errors.type)) {
      throw new TypeError(`${operation.errorsType} must be an object type`);
    }
    validateIndexedAlias(
      aliases.get(responseType),
      operation.responsesType,
      responseType,
    );
    validateIndexedAlias(
      aliases.get(errorType),
      operation.errorsType,
      errorType,
    );
    operation.requestGroups = validateRequestType(
      aliases.get(operation.dataType),
      operation,
    );
    operation.responseType = responseType;
    operation.errorType = errorType;
  }
}

export function extractAliases(filename, source, sdkOperations) {
  const sourceFile = parseTypeScript(filename, source);
  const operationNames = new Set(
    sdkOperations.map((operation) => operation.functionName),
  );
  const aliasNames = new Set();
  const aliasTargets = new Set();
  const aliases = new Map();
  let generatedStarExports = 0;

  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "./generated/index.js"
    ) {
      continue;
    }
    if (statement.exportClause === undefined) {
      generatedStarExports += 1;
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (element.propertyName === undefined) {
        continue;
      }
      const target = element.propertyName.text;
      const alias = element.name.text;
      if (!operationNames.has(target)) {
        throw new TypeError(
          `Unknown generated operation alias: ${target} as ${alias}`,
        );
      }
      if (
        aliasNames.has(alias) ||
        aliasTargets.has(target) ||
        operationNames.has(alias)
      ) {
        throw new TypeError(`Duplicate or colliding operation alias: ${alias}`);
      }
      aliasNames.add(alias);
      aliasTargets.add(target);
      aliases.set(target, alias);
    }
  }

  if (generatedStarExports !== 1) {
    throw new TypeError(
      "src/index.ts must export the generated SDK surface exactly once",
    );
  }
  return aliases;
}

function correlateOperations(openApi, sdkOperations) {
  const sdkByKey = new Map(
    sdkOperations.map((operation) => [operation.key, operation]),
  );
  const openApiKeys = new Set(
    openApi.operations.map((operation) => operation.key),
  );
  const correlated = [];

  for (const operation of openApi.operations) {
    const sdkOperation = sdkByKey.get(operation.key);
    if (sdkOperation === undefined) {
      throw new TypeError(
        `OpenAPI operation ${operation.key} has no generated SDK function`,
      );
    }
    if (sdkOperation.functionName !== operation.functionName) {
      throw new TypeError(
        `OpenAPI operation ${operation.key} maps to ${operation.functionName}, not ${sdkOperation.functionName}`,
      );
    }
    if (sdkOperation.authenticated !== operation.authenticated) {
      throw new TypeError(
        `Authentication mismatch for ${operation.functionName} (${operation.key})`,
      );
    }
    correlated.push({ ...operation, ...sdkOperation });
  }
  for (const operation of sdkOperations) {
    if (!openApiKeys.has(operation.key)) {
      throw new TypeError(
        `Generated SDK function ${operation.functionName} has no OpenAPI operation: ${operation.key}`,
      );
    }
  }
  return correlated;
}

function escapeMdxText(value) {
  return value
    .replace(/\s+/gu, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("`", "&#96;")
    .replaceAll("|", "&#124;");
}

function renderRequestGroups(groups) {
  if (groups.length === 0) {
    return "None";
  }
  return groups
    .map(
      ({ name, required }) =>
        `\`${name}\` (${required ? "required" : "optional"})`,
    )
    .join("<br />");
}

function renderFunction(operation, aliases) {
  const alias = aliases.get(operation.functionName);
  return alias === undefined
    ? `\`${operation.functionName}\``
    : `\`${operation.functionName}\`<br />Alias: \`${alias}\``;
}

function renderTypes(operation) {
  return [
    `\`${operation.dataType}\``,
    `\`${operation.responseType}\` / \`${operation.responsesType}\``,
    `\`${operation.errorType}\` / \`${operation.errorsType}\``,
  ].join("<br />");
}

export function buildReferenceRegion({
  indexFilename = "src/index.ts",
  indexSource,
  openApiDocument,
  sdkFilename = "src/generated/sdk.gen.ts",
  sdkSource,
  typesFilename = "src/generated/types.gen.ts",
  typesSource,
}) {
  const openApi = extractOpenApiOperations(openApiDocument);
  const sdkOperations = extractSdkOperations(sdkFilename, sdkSource);
  const operations = correlateOperations(openApi, sdkOperations);
  extractOperationTypes(typesFilename, typesSource, operations);
  const aliases = extractAliases(indexFilename, indexSource, operations);
  const operationsByDomain = new Map();
  for (const domain of openApi.domainOrder) {
    operationsByDomain.set(domain, []);
  }
  for (const operation of operations) {
    operationsByDomain.get(operation.domain).push(operation);
  }

  const sections = [];
  for (const domain of openApi.domainOrder) {
    const domainOperations = operationsByDomain.get(domain);
    if (domainOperations.length === 0) {
      continue;
    }
    const rows = domainOperations.map(
      (operation) =>
        `| ${renderFunction(operation, aliases)} | ${escapeMdxText(operation.summary)} | ${renderRequestGroups(operation.requestGroups)} | ${operation.authenticated ? "Bearer" : "Public"} | \`${operation.method} ${operation.path}\` | ${renderTypes(operation)} |`,
    );
    sections.push(
      [
        `### ${escapeMdxText(domain)}`,
        "",
        "| Function | Purpose | Request groups | Auth | HTTP endpoint | Generated types |",
        "| --- | --- | --- | --- | --- | --- |",
        ...rows,
      ].join("\n"),
    );
  }

  return {
    aliasCount: aliases.size,
    content: sections.join("\n\n"),
    domainCount: sections.length,
    operationCount: operations.length,
  };
}

function markerCount(source, marker) {
  return source.split(marker).length - 1;
}

function assertStandaloneMarker(source, marker, index) {
  const before = index === 0 ? "\n" : source[index - 1];
  const afterIndex = index + marker.length;
  const after = afterIndex === source.length ? "\n" : source[afterIndex];
  if (before !== "\n" || (after !== "\n" && after !== "\r")) {
    throw new TypeError(`${marker} must be on its own line`);
  }
}

export function replaceReferenceRegion(pageSource, content) {
  const startCount = markerCount(pageSource, REFERENCE_START_MARKER);
  const endCount = markerCount(pageSource, REFERENCE_END_MARKER);
  if (startCount !== 1) {
    throw new TypeError(
      `Expected exactly one ${REFERENCE_START_MARKER}, found ${startCount}`,
    );
  }
  if (endCount !== 1) {
    throw new TypeError(
      `Expected exactly one ${REFERENCE_END_MARKER}, found ${endCount}`,
    );
  }
  const start = pageSource.indexOf(REFERENCE_START_MARKER);
  const end = pageSource.indexOf(REFERENCE_END_MARKER);
  assertStandaloneMarker(pageSource, REFERENCE_START_MARKER, start);
  assertStandaloneMarker(pageSource, REFERENCE_END_MARKER, end);
  if (end < start) {
    throw new TypeError("SDK reference markers are in the wrong order");
  }
  const contentStart = start + REFERENCE_START_MARKER.length;
  return `${pageSource.slice(0, contentStart)}\n\n${content}\n\n${pageSource.slice(end)}`;
}

export async function runReferenceGenerator({ mode, pagePath, root }) {
  const inputRoot = resolve(root ?? repositoryRoot);
  const resolvedPagePath = resolve(pagePath);
  const [openApiSource, sdkSource, typesSource, indexSource, pageSource] =
    await Promise.all([
      readFile(resolve(inputRoot, "openapi.json"), "utf8"),
      readFile(resolve(inputRoot, "src/generated/sdk.gen.ts"), "utf8"),
      readFile(resolve(inputRoot, "src/generated/types.gen.ts"), "utf8"),
      readFile(resolve(inputRoot, "src/index.ts"), "utf8"),
      readFile(resolvedPagePath, "utf8"),
    ]);
  let openApiDocument;
  try {
    openApiDocument = JSON.parse(openApiSource);
  } catch (error) {
    throw new TypeError(`Invalid openapi.json: ${error.message}`);
  }
  const reference = buildReferenceRegion({
    indexSource,
    openApiDocument,
    sdkSource,
    typesSource,
  });
  const expectedPage = replaceReferenceRegion(pageSource, reference.content);
  if (mode === "check") {
    if (expectedPage !== pageSource) {
      throw new Error(
        `SDK reference is out of date: run pnpm docs:reference -- --write ${pagePath}`,
      );
    }
  } else if (mode === "write") {
    if (expectedPage !== pageSource) {
      await writeFile(resolvedPagePath, expectedPage);
    }
  } else {
    throw new TypeError(`Unsupported SDK reference mode: ${mode}`);
  }
  return reference;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "--") {
    arguments_.shift();
  }
  const [modeArgument, pageArgument, ...extraArguments] = arguments_;
  if (
    (modeArgument !== "--write" && modeArgument !== "--check") ||
    pageArgument === undefined ||
    extraArguments.length !== 0
  ) {
    throw new TypeError(
      "Usage: node scripts/generate-sdk-reference.mjs (--write|--check) <page>",
    );
  }
  const mode = modeArgument.slice(2);
  const reference = await runReferenceGenerator({
    mode,
    pagePath: resolve(process.cwd(), pageArgument),
    root: process.env.PERFLO_SDK_REFERENCE_ROOT,
  });
  console.log(
    `SDK reference ${mode} passed: ${reference.operationCount} operations across ${reference.domainCount} domains with ${reference.aliasCount} aliases.`,
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
