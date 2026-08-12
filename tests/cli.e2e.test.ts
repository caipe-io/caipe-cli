/**
 * E2E: CLI entrypoints (Node/tsx — not raw Bun binaries on PATH).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "bin/caipe.cjs");
const pathStub = join(root, "bin/caipe-path.cjs");

const nodeEnv = {
  ...process.env,
  CAIPE_USE_COMPILED: "",
  CAIPE_CLI_ROOT: root,
};

describe("bin/caipe.cjs", () => {
  it("prints version via Node/tsx", async () => {
    const { stdout, exitCode } = await execa(process.execPath, [launcher, "--version"], {
      cwd: root,
      env: nodeEnv,
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("default action in non-TTY exits without SIGKILL", async () => {
    const r = await execa(process.execPath, [launcher], {
      cwd: root,
      env: nodeEnv,
      reject: false,
    });
    expect(r.signal).not.toBe("SIGKILL");
    expect(r.exitCode).not.toBe(137);
    expect(r.stderr || r.stdout).toMatch(/credentials|headless|ERROR/i);
  });

  it("prints top-level help", async () => {
    const { stdout, exitCode } = await execa(process.execPath, [launcher, "--help"], {
      cwd: root,
      env: nodeEnv,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/chat|config|auth/i);
  });
});

describe("bin/caipe-path.cjs", () => {
  it("delegates to the checkout when CAIPE_CLI_ROOT is set", async () => {
    const { stdout, exitCode } = await execa(process.execPath, [pathStub, "--version"], {
      env: { ...nodeEnv, CAIPE_CLI_ROOT: root },
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
