/**
 * E2E: CLI entrypoints (Node/tsx — not raw Bun binaries on PATH).
 */

import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
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
  it("discovers all fresh agents with one renewable app credential and rejects a failed refresh", async () => {
    let registryStatus = 200;
    let tokenRequests = 0;
    const pages: number[] = [];
    const server = createServer(async (req, res) => {
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/token") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body);
        if (
          form.get("client_id") !== "app-client" ||
          form.get("client_secret") !== "app-secret" ||
          form.get("grant_type") !== "client_credentials"
        ) {
          json({ error: "invalid_client" }, 401);
          return;
        }
        tokenRequests++;
        json({ access_token: "app-access-token", expires_in: 300 });
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (
        url.pathname !== "/api/user/accessible-agents" ||
        req.headers.authorization !== "Bearer app-access-token"
      ) {
        json({ error: "unauthorized" }, 401);
        return;
      }
      if (registryStatus !== 200) {
        json({ success: false }, registryStatus);
        return;
      }
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      json({
        success: true,
        data: {
          total: 2,
          page,
          agents: [
            {
              id: page === 1 ? "agent-sre" : "agent-created-later",
              name: page === 1 ? "SRE" : "New custom agent",
              description: "CAIPE-owned reference",
            },
          ],
        },
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const base = `http://127.0.0.1:${address.port}`;
    const configDir = mkdtempSync(join(tmpdir(), "caipe-app-connection-"));
    const env = {
      ...nodeEnv,
      XDG_CONFIG_HOME: configDir,
      CAIPE_NO_UPDATE_CHECK: "1",
      CAIPE_TOKEN: undefined,
      CAIPE_API_KEY: undefined,
      CAIPE_CLIENT_ID: "app-client",
      CAIPE_CLIENT_SECRET: "app-secret",
      CAIPE_TOKEN_URL: `${base}/token`,
    };
    const args = [launcher, "--url", base, "agents", "list", "--refresh", "--json"];
    try {
      const result = await execa(process.execPath, args, { cwd: root, env });
      expect(JSON.parse(result.stdout).map((agent: { name: string }) => agent.name)).toEqual([
        "agent-sre",
        "agent-created-later",
      ]);
      expect(pages).toEqual([1, 2]);
      expect(tokenRequests).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("app-secret");
      expect(result.stdout + result.stderr).not.toContain("app-access-token");
      registryStatus = 503;
      const failed = await execa(process.execPath, args, { cwd: root, env, reject: false });
      expect(failed.exitCode).not.toBe(0);
      expect(failed.stdout).not.toContain("agent-created-later");
      expect(failed.stderr).toContain("HTTP 503");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(configDir, { recursive: true, force: true });
    }
  });

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
