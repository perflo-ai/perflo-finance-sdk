import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve(
  process.env.PERFLO_SDK_OUTPUT ?? "src/generated",
);
const openapiPath = resolve(process.env.PERFLO_SDK_OPENAPI ?? "openapi.json");
const typesPath = resolve(outputDirectory, "types.gen.ts");
const httpMethods = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

function declarationName(operationId) {
  const name = operationId
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
  if (!name) {
    throw new Error(`Cannot derive an error declaration from ${operationId}`);
  }
  return `${name}Errors`;
}

function schemaType(schema, context) {
  const reference = schema?.$ref;
  const prefix = "#/components/schemas/";
  if (typeof reference !== "string" || !reference.startsWith(prefix)) {
    throw new Error(`${context} uses an unsupported non-component schema`);
  }
  return reference.slice(prefix.length);
}

function mixedContentUnions(openapi) {
  const mappings = new Map();
  for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!httpMethods.has(method)) {
        continue;
      }
      for (const [status, response] of Object.entries(
        operation.responses ?? {},
      )) {
        const content = Object.values(response.content ?? {});
        if (content.length <= 1) {
          continue;
        }
        if (typeof operation.operationId !== "string") {
          throw new Error(
            `${method.toUpperCase()} ${path} ${status} has no operationId`,
          );
        }

        const context = `${method.toUpperCase()} ${path} ${status}`;
        const union = [
          ...new Set(content.map((media) => schemaType(media.schema, context))),
        ];
        const typeName = declarationName(operation.operationId);
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

const openapi = JSON.parse(await readFile(openapiPath, "utf8"));
const mappings = mixedContentUnions(openapi);
let source = await readFile(typesPath, "utf8");

for (const [typeName, statuses] of mappings) {
  const original = errorDeclaration(source, typeName);
  let patched = original;
  for (const [status, types] of statuses) {
    const property = new RegExp(
      `^([ \\t]+${escapeRegExp(status)}:[ \\t]*)([^;\\r\\n]+);$`,
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
