import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { discoverOperations } from "./lib/generated-operations.mjs";
import { definitionsProfile, generatorNames } from "./lib/generator-naming.mjs";
import { isRecord, requireOperations } from "./lib/openapi.mjs";

const outputDirectory = resolve(
  process.env.PERFLO_SDK_OUTPUT ?? "src/generated",
);
const openapiPath = resolve(process.env.PERFLO_SDK_OPENAPI ?? "openapi.json");
const sdkPath = resolve(outputDirectory, "sdk.gen.ts");
const typesPath = resolve(outputDirectory, "types.gen.ts");

function schemaRef(schema, context) {
  const reference = schema?.$ref;
  const prefix = "#/components/schemas/";
  if (typeof reference !== "string" || !reference.startsWith(prefix)) {
    throw new Error(`${context} uses an unsupported non-component schema`);
  }
  return reference.slice(prefix.length);
}

function mixedContentUnions(openapi, generatedOperations, schemaNames) {
  const mappings = new Map();
  for (const { operation, route } of requireOperations(openapi)) {
    for (const [status, response] of Object.entries(
      operation.responses ?? {},
    )) {
      const context = `${route} ${status}`;
      if (!isRecord(response)) {
        throw new TypeError(`Invalid OpenAPI response: ${context}`);
      }
      if (Object.hasOwn(response, "$ref")) {
        throw new TypeError(
          `${context} uses an unsupported response reference; it must be resolved before generation`,
        );
      }
      const content = Object.values(response.content ?? {});
      if (content.length <= 1) {
        continue;
      }
      if (status !== "default" && !/^[45]/.test(status)) {
        throw new Error(
          `${context} publishes more than one media type on a non-error status; ` +
            "generated types keep at most the first media type when they keep the status " +
            "at all — extend the patch before shipping this contract",
        );
      }
      const generatedOperation = generatedOperations.get(route);
      if (generatedOperation === undefined) {
        throw new Error(`sdk.gen.ts has no generated operation for ${route}`);
      }
      const typeName = generatedOperation.errorsType;
      if (typeName === undefined) {
        throw new Error(
          `sdk.gen.ts generated operation for ${route} has no named error type`,
        );
      }

      const refs = [
        ...new Set(content.map((media) => schemaRef(media.schema, context))),
      ];
      const union = refs.map((ref) => {
        const name = schemaNames.get(ref);
        if (name === undefined) {
          throw new Error(
            `${context} references missing component schema ${ref}`,
          );
        }
        return name;
      });
      const statuses = mappings.get(typeName) ?? new Map();
      if (statuses.has(status)) {
        throw new Error(
          `Duplicate mixed-content mapping for ${typeName} ${status}`,
        );
      }
      statuses.set(status, union);
      mappings.set(typeName, statuses);
    }
  }
  return mappings;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorDeclaration(source, typeName) {
  const match = source.match(
    new RegExp(`export type ${escapeRegExp(typeName)} = \\{[\\s\\S]*?\\n\\};`),
  );
  if (!match) {
    throw new Error(`Missing generated ${typeName} declaration`);
  }
  return match[0];
}

const [openapiSource, sdkSource, typesSource] = await Promise.all([
  readFile(openapiPath, "utf8"),
  readFile(sdkPath, "utf8"),
  readFile(typesPath, "utf8"),
]);
const openapi = JSON.parse(openapiSource);
const schemaKeys = Object.keys(openapi.components?.schemas ?? {});
for (const key of schemaKeys) {
  if (!/^[a-zA-Z0-9._-]+$/u.test(key)) {
    throw new TypeError(
      `Invalid OpenAPI component schema key ${JSON.stringify(key)}; keys must match ^[a-zA-Z0-9._-]+$`,
    );
  }
}
const schemaNames = generatorNames(schemaKeys, {
  ...definitionsProfile,
  label: "Component schema",
});
const mappings = mixedContentUnions(
  openapi,
  discoverOperations(sdkPath, sdkSource),
  schemaNames,
);
let source = typesSource;

for (const [typeName, statuses] of mappings) {
  const original = errorDeclaration(source, typeName);
  let patched = original;
  for (const [status, types] of statuses) {
    const property = new RegExp(
      `^([ \\t]+"?${escapeRegExp(status)}"?:[ \\t]*)([^;\\r\\n]+);$`,
      "m",
    );
    const match = patched.match(property);
    if (!match) {
      throw new Error(`Missing generated ${typeName} status ${status}`);
    }

    const expected = types.join(" | ");
    const generated = match[2].trim();
    if (generated !== types[0] && generated !== expected) {
      throw new Error(
        `Generated ${typeName} status ${status} has unexpected type ${generated}`,
      );
    }
    patched = patched.replace(property, `$1${expected};`);
  }
  source = source.replace(original, patched);
}

await writeFile(typesPath, source);
console.log(`Widened ${mappings.size} generated error declarations`);
