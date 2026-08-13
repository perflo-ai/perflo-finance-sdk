import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(
  resolve(tmpdir(), "perflo-sdk-package-"),
);
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: packageDirectory,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
}

try {
  run("pnpm", ["pack", "--pack-destination", temporaryDirectory]);

  const archives = (await readdir(temporaryDirectory)).filter((entry) =>
    entry.endsWith(".tgz"),
  );
  if (archives.length !== 1) {
    throw new Error(`Expected one package archive, found ${archives.length}`);
  }

  const archivePath = resolve(temporaryDirectory, archives[0]);
  const entries = execFileSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  const allowedEntry =
    /^package\/(?:dist\/|LICENSE$|README\.md$|package\.json$)/;
  const unexpectedEntries = entries.filter(
    (entry) => !allowedEntry.test(entry),
  );
  if (unexpectedEntries.length) {
    throw new Error(
      `Unexpected package entries: ${unexpectedEntries.join(", ")}`,
    );
  }

  const consumerDirectory = resolve(temporaryDirectory, "consumer");
  const installedPackage = resolve(
    consumerDirectory,
    "node_modules/@perflo/finance-sdk",
  );
  await mkdir(installedPackage, { recursive: true });
  run("tar", [
    "-xzf",
    archivePath,
    "-C",
    installedPackage,
    "--strip-components=1",
  ]);

  const distDirectory = resolve(installedPackage, "dist");
  const distEntries = await readdir(distDirectory, { recursive: true });
  const javascriptEntries = distEntries.filter((entry) =>
    entry.endsWith(".js"),
  );
  const sourceMapEntries = new Set(
    distEntries.filter((entry) => entry.endsWith(".js.map")),
  );
  if (sourceMapEntries.size === 0) {
    throw new Error("Package contains no JavaScript source maps");
  }

  for (const entry of javascriptEntries) {
    const sourceMapEntry = `${entry}.map`;
    if (!sourceMapEntries.has(sourceMapEntry)) {
      throw new Error(`JavaScript file ${entry} has no source map`);
    }
    const javascript = await readFile(resolve(distDirectory, entry), "utf8");
    if (
      !javascript.includes(`//# sourceMappingURL=${basename(sourceMapEntry)}`)
    ) {
      throw new Error(`JavaScript file ${entry} has no source map reference`);
    }

    const sourceMap = JSON.parse(
      await readFile(resolve(distDirectory, sourceMapEntry), "utf8"),
    );
    if (
      !Array.isArray(sourceMap.sources) ||
      sourceMap.sources.length === 0 ||
      !Array.isArray(sourceMap.sourcesContent) ||
      sourceMap.sourcesContent.length !== sourceMap.sources.length ||
      sourceMap.sourcesContent.some((source) => typeof source !== "string")
    ) {
      throw new Error(
        `Source map ${sourceMapEntry} does not contain its sources`,
      );
    }
  }

  await writeFile(
    resolve(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await writeFile(
    resolve(consumerDirectory, "runtime.mjs"),
    `import { createPerfloClient, getIdentity } from "@perflo/finance-sdk";\n\nconst client = createPerfloClient();\nif (typeof getIdentity !== "function" || client.getConfig().baseUrl !== "https://api-gateway.perflo.ai") {\n  throw new Error("Packed runtime exports are invalid");\n}\n`,
  );
  await writeFile(
    resolve(consumerDirectory, "types.ts"),
    `import { createPerfloClient, getIdentity, type Money } from "@perflo/finance-sdk";\n\nconst money: Money = { amount: "1.00", currency: "USD" };\nvoid money;\nvoid getIdentity({ client: createPerfloClient() });\n`,
  );
  await writeFile(
    resolve(consumerDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
      },
      files: [resolve(consumerDirectory, "types.ts")],
    }),
  );

  run(process.execPath, [resolve(consumerDirectory, "runtime.mjs")], {
    cwd: consumerDirectory,
  });
  run(
    process.execPath,
    [
      resolve(packageDirectory, "node_modules/typescript/bin/tsc"),
      "-p",
      resolve(consumerDirectory, "tsconfig.json"),
    ],
    { cwd: consumerDirectory },
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
