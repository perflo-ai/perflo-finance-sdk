import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve(
  process.env.PERFLO_SDK_OUTPUT ?? "src/generated",
);
const typesPath = resolve(outputDirectory, "types.gen.ts");
const bareCliErrorResponse = ": CliErrorResponse;";
const cliErrorUnion = ": CliErrorResponse | ProblemDetails;";
const problemDetailsType = /\bProblemDetails\b/;
const errorTypes = [
  "DevicesErrors",
  "PollDeviceErrors",
  "PollSignErrors",
  "RefreshTokenErrors",
  "RevokeTokenErrors",
  "StartDeviceErrors",
  "StartSignErrors",
];

function errorDeclaration(source, typeName) {
  const match = source.match(
    new RegExp(`export type ${typeName} = \\{[\\s\\S]*?\\n\\};`),
  );
  if (!match) {
    throw new Error(`Missing generated ${typeName} declaration`);
  }

  return match[0];
}

function declarationsCarryingCliErrorResponse(source) {
  return [...source.matchAll(/export type (\w+) = \{[\s\S]*?\n\};/g)]
    .map((match) => ({
      properties: [
        ...match[0].matchAll(
          /^[ \t]+([^*/\s][^:\r\n]*):[ \t]*([^;]*\bCliErrorResponse\b[^;]*);/gm,
        ),
      ].map((property) => ({
        status: property[1],
        type: property[2],
      })),
      typeName: match[1],
    }))
    .filter((declaration) => declaration.properties.length > 0);
}

let source = await readFile(typesPath, "utf8");

for (const typeName of errorTypes) {
  const original = errorDeclaration(source, typeName);
  const patched = original.replaceAll(bareCliErrorResponse, cliErrorUnion);
  if (patched === original) {
    throw new Error(`Generated ${typeName} has no CLI error responses`);
  }

  source = source.replace(original, patched);
}

const errorTypeNames = new Set(errorTypes);
for (const declaration of declarationsCarryingCliErrorResponse(source)) {
  if (!errorTypeNames.has(declaration.typeName)) {
    throw new Error(
      `Unexpected generated CLI error declaration ${declaration.typeName}`,
    );
  }

  const missingProblemDetails = declaration.properties
    .filter((property) => !problemDetailsType.test(property.type))
    .map((property) => property.status);
  if (missingProblemDetails.length > 0) {
    throw new Error(
      `Generated ${declaration.typeName} CLI error responses missing ProblemDetails: ${missingProblemDetails.join(", ")}`,
    );
  }
}

await writeFile(typesPath, source);
