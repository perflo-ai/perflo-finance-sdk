import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve(
  process.env.PERFLO_SDK_OUTPUT ?? "src/generated",
);
const typesPath = resolve(outputDirectory, "types.gen.ts");
const errorTypes = [
  "DevicesErrors",
  "PollDeviceErrors",
  "RefreshTokenErrors",
  "RevokeTokenErrors",
  "StartDeviceErrors",
];

let source = await readFile(typesPath, "utf8");
let replacementCount = 0;

for (const typeName of errorTypes) {
  const pattern = new RegExp(
    `(export type ${typeName} = \\{[\\s\\S]*?\\n\\};)`,
  );
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`Missing generated ${typeName} declaration`);
  }

  const original = match[1];
  const patched = original.replaceAll(
    ": CliErrorResponse;",
    ": CliErrorResponse | ProblemDetails;",
  );
  if (patched === original) {
    throw new Error(`Generated ${typeName} has no CLI error responses`);
  }

  replacementCount += original.split(": CliErrorResponse;").length - 1;
  source = source.replace(original, patched);
}

if (replacementCount !== 15) {
  throw new Error(`Expected 15 CLI error unions, found ${replacementCount}`);
}

await writeFile(typesPath, source);
