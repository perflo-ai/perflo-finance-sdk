import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { discoverOperations } from "./lib/generated-operations.mjs";
import { requireOperations } from "./lib/openapi.mjs";
import { objectPropertyName } from "./lib/typescript.mjs";

const repositoryRoot = resolve(
  process.env.PERFLO_SDK_RESULT_CONTRACT_ROOT ?? ".",
);
const openApiPath = process.env.PERFLO_SDK_OPENAPI
  ? resolve(process.env.PERFLO_SDK_OPENAPI)
  : resolve(repositoryRoot, "openapi.json");
const outputDirectory = resolve(
  repositoryRoot,
  process.env.PERFLO_SDK_OUTPUT ?? "src/generated",
);
const sdkPath = resolve(outputDirectory, "sdk.gen.ts");
const clientPath = resolve(outputDirectory, "client/client.gen.ts");
const clientTypesPath = resolve(outputDirectory, "client/types.gen.ts");

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

function openApiOperationRoutes(document) {
  const routes = new Set();
  for (const { route } of requireOperations(document)) {
    routes.add(route);
  }
  return routes;
}

function patchSdk(source, expectedOperations) {
  let patched = replaceInvariant(
    source,
    unpatchedSdkOptions,
    patchedSdkOptions,
    "operation Options type",
  );
  const discovered = discoverOperations(sdkPath, patched);

  const missing = [...expectedOperations].filter(
    (route) => !discovered.has(route),
  );
  if (missing.length > 0) {
    throw new TypeError(
      `Generated SDK operation mismatch: expected ${expectedOperations.size}, found ${discovered.size}; missing ${missing.join(", ")}`,
    );
  }
  const unexpected = [...discovered.keys()].filter(
    (route) => !expectedOperations.has(route),
  );
  if (unexpected.length > 0) {
    throw new TypeError(
      `Generated SDK operation mismatch: expected ${expectedOperations.size}, found ${discovered.size}; unexpected ${unexpected.join(", ")}`,
    );
  }

  const insertions = [];
  for (const { name, object, sourceFile } of discovered.values()) {
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
    const previous = patched.slice(0, closingBrace).trimEnd().at(-1);
    if (/^\s*$/u.test(closingIndent)) {
      if (previous !== ",") {
        throw new TypeError(
          `Generated operation ${name} object must use trailing commas`,
        );
      }
      insertions.push({
        end: closingBrace,
        position: closingBrace,
        text: `  parseAs: "json",\n${closingIndent}  responseStyle: "fields",\n${closingIndent}`,
      });
      continue;
    }
    const objectStart = object.getStart(sourceFile);
    const objectLinePrefix = patched.slice(lineStart, objectStart);
    const objectIndent = objectLinePrefix.match(/^\s*/u)?.[0] ?? "";
    const propertyIndent = `${objectIndent}  `;
    const properties = object.properties.map((property) =>
      property.getText(sourceFile),
    );
    insertions.push({
      end: object.getEnd(),
      position: objectStart,
      text: `{\n${propertyIndent}${properties.join(`,\n${propertyIndent}`)},\n${propertyIndent}parseAs: "json",\n${propertyIndent}responseStyle: "fields",\n${objectIndent}}`,
    });
  }

  for (const insertion of insertions.sort(
    (left, right) => right.position - left.position,
  )) {
    patched = `${patched.slice(0, insertion.position)}${insertion.text}${patched.slice(insertion.end)}`;
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
const expectedOperations = openApiOperationRoutes(document);
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
