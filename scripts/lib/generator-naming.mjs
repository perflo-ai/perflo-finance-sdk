// The pinned generator's name derivation and its refusal rules belong here.

import { applyNaming, Logger, regexp, reserved } from "@hey-api/openapi-ts";
import { initConfigs } from "@hey-api/openapi-ts/internal";
import generatorConfig from "../../openapi-ts.config.ts";

const generatorReservedNames = {
  runtime: reserved.runtime["~values"],
  type: reserved.type["~values"],
};

const resolvedConfigs = await initConfigs({
  logger: new Logger(),
  userConfigs: [await generatorConfig],
});
const resolvedJob = resolvedConfigs.jobs[0];
if (resolvedConfigs.jobs.length !== 1 || resolvedJob.errors.length !== 0) {
  throw new TypeError("Unable to resolve the pinned generator configuration");
}
const operationNestingDelimiters =
  resolvedJob.config.plugins["@hey-api/sdk"].config.operations
    .nestingDelimiters;
if (!(operationNestingDelimiters instanceof RegExp)) {
  throw new TypeError(
    "Pinned SDK operation nesting delimiters must be a regular expression",
  );
}

// Pinned @hey-api/sdk operations.methodName default.
export const operationsProfile = {
  naming: { casing: "camelCase", name: "" },
  nestingDelimiters: operationNestingDelimiters,
  reservedNames: generatorReservedNames.runtime,
};

// Pinned @hey-api/typescript definitions default, with the plugin-level
// `case` it cascades.
export const definitionsProfile = {
  naming: { case: "PascalCase", name: "{{name}}" },
  reservedNames: generatorReservedNames.type,
};

function generatorName(
  source,
  { naming, nestingDelimiters, reservedNames, label },
) {
  if (nestingDelimiters !== undefined) {
    nestingDelimiters.lastIndex = 0;
    if (nestingDelimiters.test(source)) {
      throw new Error(
        `${label} ${source} carries a nesting delimiter, which the generator normalizes before naming, and this module does not model that normalization`,
      );
    }
  }
  const name = applyNaming(source, naming);
  if (name.length === 0) {
    throw new Error(
      `${label} ${source} generates an empty name, which the generator replaces with _`,
    );
  }
  regexp.illegalStartCharacters.lastIndex = 0;
  let safe = !regexp.illegalStartCharacters.test(name[0]);
  // This check mirrors safeName's UTF-16 code-unit continuation rule.
  // regexp.typeScriptIdentifier is not a substitute: its continuation class
  // includes `$`, while safeName's validTypeScriptChar does not.
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: ZWNJ and ZWJ are valid identifier continuations.
  const safeContinuation = /^[\u200c\u200d\p{ID_Continue}]$/u;
  for (let index = 1; safe && index < name.length; index += 1) {
    safe = safeContinuation.test(name[index]);
  }
  if (!safe) {
    throw new Error(
      `${label} ${source} generates ${name}, which the generator sanitizes`,
    );
  }
  if (reservedNames.has(name)) {
    throw new Error(
      `${label} ${source} generates ${name}, which the generator reserves and would suffix`,
    );
  }
  return name;
}

export function generatorNames(sources, profile) {
  const names = new Map();
  const owners = new Map();
  for (const source of sources) {
    const name = generatorName(source, profile);
    const owner = owners.get(name);
    if (owner !== undefined) {
      throw new Error(
        `${profile.label}s ${owner} and ${source} both generate ${name}`,
      );
    }
    owners.set(name, source);
    names.set(source, name);
  }
  // This proves injectivity only within the supplied source class. It does not
  // model conflicts with declarations already emitted into the same file.
  return names;
}
