import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDirectory = resolve(packageDirectory, process.argv[2] ?? "dist");
const sourceExtensions = [".js", ".mjs", ".cjs", ".d.ts", ".d.mts", ".d.cts"];

function isSourceFile(path) {
  return sourceExtensions.some((extension) => path.endsWith(extension));
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory()
        ? listSourceFiles(path)
        : Promise.resolve(isSourceFile(path) ? [path] : []);
    }),
  );
  return files.flat();
}

function moduleSpecifier(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.arguments.length > 0 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require"))
  ) {
    return node.arguments[0].text;
  }
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    return node.argument.literal.text;
  }
  if (
    ts.isExternalModuleReference(node) &&
    node.expression !== undefined &&
    ts.isStringLiteralLike(node.expression)
  ) {
    return node.expression.text;
  }
}

function findNodeImports(source, path) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = new Set();
  function visit(node) {
    const specifier = moduleSpecifier(node);
    if (
      specifier !== undefined &&
      (specifier.startsWith("node:") || isBuiltin(specifier))
    ) {
      imports.add(specifier);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

let files;
try {
  files = await listSourceFiles(targetDirectory);
} catch (error) {
  throw new Error(`Cannot scan ${targetDirectory}`, { cause: error });
}

const violations = [];
for (const path of files) {
  const source = await readFile(path, "utf8");
  for (const specifier of findNodeImports(source, path)) {
    violations.push(
      `${path.slice(targetDirectory.length + 1)} imports ${JSON.stringify(specifier)}`,
    );
  }
}

if (violations.length > 0) {
  throw new Error(
    `workerd-incompatible Node imports found:\n${violations.join("\n")}`,
  );
}

function runNodeCheck(args, errorMessage) {
  const result = spawnSync(process.execPath, args, {
    cwd: packageDirectory,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw new Error(errorMessage, { cause: result.error });
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

if (process.argv[2] === undefined) {
  const typecheckPassed = runNodeCheck(
    [
      resolve(packageDirectory, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "-p",
      resolve(packageDirectory, "tests/tsconfig.workerd.json"),
    ],
    "Cannot start the workerd smoke typecheck",
  );
  if (typecheckPassed) {
    runNodeCheck(
      [
        resolve(packageDirectory, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        resolve(packageDirectory, "tests/vitest.workerd.config.ts"),
      ],
      "Cannot start the workerd runtime smoke",
    );
  }
}
