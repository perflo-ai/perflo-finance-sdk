import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageDirectory = resolve(import.meta.dirname, "..");
const scriptPath = resolve(packageDirectory, "scripts/check-workerd.mjs");

async function withTemporaryDist(
  source: string,
  callback: (directory: string) => void,
  filename = "index.js",
) {
  const directory = await mkdtemp(resolve(tmpdir(), "perflo-workerd-test-"));
  try {
    await writeFile(resolve(directory, filename), source);
    callback(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("workerd safety check", () => {
  it("passes a clean ESM dist", async () => {
    await withTemporaryDist(
      'export { client } from "./client.js";\n',
      (dist) => {
        const result = spawnSync(process.execPath, [scriptPath, dist], {
          cwd: packageDirectory,
          encoding: "utf8",
        });

        expect(result.status, result.stderr).toBe(0);
      },
    );
  });

  it.each([
    ["node: import", 'import "node:fs";\n'],
    ["unknown node: import", 'import("node:not-a-runtime-module");\n'],
    ["bare Node builtin", 'export { join } from "path";\n'],
  ])("fails on a planted %s", async (_name, source) => {
    await withTemporaryDist(source, (dist) => {
      const result = spawnSync(process.execPath, [scriptPath, dist], {
        cwd: packageDirectory,
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("workerd-incompatible Node imports");
    });
  });

  it.each([
    ["node: import type", 'type File = import("node:fs").Stats;\n'],
    ["bare builtin import type", 'import type { Stats } from "fs";\n'],
  ])("fails on a planted %s", async (_name, source) => {
    await withTemporaryDist(
      source,
      (dist) => {
        const result = spawnSync(process.execPath, [scriptPath, dist], {
          cwd: packageDirectory,
          encoding: "utf8",
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("workerd-incompatible Node imports");
      },
      "index.d.ts",
    );
  });
});
