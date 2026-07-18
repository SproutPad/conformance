import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectCliInvocation } from "../bin/sproutpad-conformance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binPath = join(root, "bin/sproutpad-conformance.mjs");

describe("CLI entrypoint", () => {
  it("treats realpath-equal argv as a direct CLI invocation", () => {
    expect(isDirectCliInvocation(binPath)).toBe(true);
  });

  it("does not treat an unrelated argv path as a CLI invocation", () => {
    expect(isDirectCliInvocation(process.execPath)).toBe(false);
  });

  it("runs --help when invoked via node on the bin path", () => {
    const result = spawnSync(process.execPath, [binPath, "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: sproutpad-conformance");
    expect(result.stderr).toBe("");
  });

  it("runs --help when invoked through an npm-style .bin symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "sproutpad-conformance-bin-"));
    const link = join(dir, "sproutpad-conformance");
    try {
      symlinkSync(binPath, link);
      const result = spawnSync(process.execPath, [link, "--help"], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: sproutpad-conformance");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
