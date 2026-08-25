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
    expect(stdout).toContain("update");
    expect(stdout).toContain("acp");
  });

  it("serves ACP initialize over clean JSON-RPC stdout", async () => {
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
      },
    });
    const { stdout, exitCode } = await execa(process.execPath, [launcher, "acp"], {
      cwd: root,
      env: nodeEnv,
      input: `${request}\n`,
    });

    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "caipe-cli" },
      },
    });
  });

  it("returns a JSON-RPC parse error for malformed ACP input", async () => {
    const { stdout, exitCode } = await execa(process.execPath, [launcher, "acp"], {
      cwd: root,
      env: nodeEnv,
      input: "{not-json}\n",
    });

    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700 },
    });
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
