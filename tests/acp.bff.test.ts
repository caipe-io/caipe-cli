import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaipeAcpAgent, type CaipeAcpDependencies } from "../src/acp/server";
import { DEFAULT_AGENT } from "../src/agents/types";
import { createAdapter } from "../src/chat/stream";
import { createTokenProvider } from "../src/headless/auth";

const agentId = "sre-agent";
const frame = (type: string, value: Record<string, unknown> = {}) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
const form = {
  id: "form-1",
  reason: "human_input",
  payload: {
    prompt: "Choose a cluster",
    fields: [
      {
        field_name: "cluster",
        field_type: "select",
        field_values: ["dev", "prod"],
        required: true,
      },
    ],
  },
};
const approval = {
  id: "approval-1",
  reason: "tool_approval",
  payload: {
    tool_name: "delete_resource",
    tool_args: { namespace: "dev" },
    allowed_decisions: ["approve", "reject"],
  },
};

interface MessageRow {
  message_id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  stream_events?: unknown[];
}
interface Conversation {
  _id: string;
  participants: Array<{ type: string; id: string }>;
  access_level: string;
  source?: string;
}

async function fixture() {
  const conversations = new Map<string, Conversation>();
  const messages = new Map<string, Map<string, MessageRow>>();
  const resumes: Record<string, unknown>[] = [];
  const cancels: string[] = [];
  const streams = new Set<ServerResponse>();
  let mode = "done";
  let tokenStatus = 200;
  let tokenExchanges = 0;
  let pending: Record<string, unknown> | undefined;
  let started = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let closed = () => {};
  const streamClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let creations = 0;
  const json = (res: ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/oauth/token") {
      tokenExchanges++;
      for await (const _chunk of req) {
        /* drain form */
      }
      json(
        res,
        tokenStatus === 200
          ? { access_token: "owner-token", expires_in: 120 }
          : { error: "echo-sensitive-secret" },
        tokenStatus,
      );
      return;
    }
    if (
      req.headers.authorization !== "Bearer owner-token" &&
      req.headers.authorization !== "Bearer readonly-token"
    ) {
      json(res, { error: "invalid token echo-sensitive-token" }, 401);
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (url.pathname === "/api/user/accessible-agents") {
      json(res, { success: true, data: { agents: [{ id: agentId, name: "SRE" }], total: 1 } });
      return;
    }
    if (url.pathname === "/api/chat/conversations" && req.method === "POST") {
      expect(body.client_type).toBe("api");
      expect(body.owner_id).toBeUndefined();
      const id = randomUUID();
      conversations.set(id, {
        _id: id,
        participants: [{ type: "agent", id: String(body.agent_id) }],
        access_level: "owner",
      });
      messages.set(id, new Map());
      creations++;
      json(res, { success: true, data: { conversation: { _id: id } } }, 201);
      return;
    }
    const match = url.pathname.match(/^\/api\/chat\/conversations\/([^/]+)(\/messages)?$/);
    if (match) {
      const id = match[1] ?? "";
      const conversation = conversations.get(id);
      if (!conversation) {
        json(res, { error: "not found" }, 404);
        return;
      }
      if (!match[2]) {
        json(res, {
          success: true,
          data: {
            ...conversation,
            access_level:
              req.headers.authorization === "Bearer readonly-token"
                ? "shared_readonly"
                : conversation.access_level,
          },
        });
        return;
      }
      if (req.method === "POST") {
        messages.get(id)?.set(String(body.message_id), body as unknown as MessageRow);
        json(res, { success: true, data: body });
        return;
      }
      json(res, {
        success: true,
        data: {
          items: [...(messages.get(id)?.values() ?? [])].map((m) => ({ ...m, _id: m.message_id })),
          has_more: false,
        },
      });
      return;
    }
    if (url.pathname.includes("interrupt-state")) {
      json(res, {
        has_pending_interrupt: Boolean(pending),
        interrupt_data: pending
          ? {
              ...(pending.payload as object),
              interrupt_id: pending.id,
              type: pending.reason === "tool_approval" ? "tool_approval" : "form_input",
            }
          : undefined,
      });
      return;
    }
    if (url.pathname === "/api/v1/chat/stream/cancel") {
      cancels.push(String(body.conversation_id));
      for (const stream of streams) stream.end();
      json(res, { success: true, cancelled: true });
      return;
    }
    if (
      url.pathname === "/api/v1/chat/stream/start" ||
      url.pathname === "/api/v1/chat/stream/resume"
    ) {
      expect(conversations.has(String(body.conversation_id))).toBe(true);
      expect(body.agent_id).toBe(agentId);
      if (url.pathname.endsWith("resume")) {
        resumes.push(JSON.parse(String(body.resume_data)));
        pending = undefined;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(frame("RUN_STARTED"));
      res.write(frame("TEXT_MESSAGE_CONTENT", { delta: "Partial answer" }));
      if (mode === "block") {
        streams.add(res);
        res.on("close", () => {
          streams.delete(res);
          closed();
        });
        started();
        return;
      }
      if (mode === "error") {
        res.end(
          frame("RUN_ERROR", {
            message: "failed Authorization: Bearer owner-token and echo-sensitive-token",
          }),
        );
        return;
      }
      if (
        (mode === "form" || mode === "approval" || mode === "approval_batch") &&
        !url.pathname.endsWith("resume")
      ) {
        pending =
          mode === "form"
            ? form
            : mode === "approval_batch"
              ? {
                  ...approval,
                  payload: {
                    ...approval.payload,
                    tool_approvals: [
                      { ...approval.payload, tool_call_id: "first" },
                      {
                        tool_name: "write_config",
                        tool_args: { file: "settings" },
                        allowed_decisions: ["reject"],
                        tool_call_id: "second",
                      },
                    ],
                  },
                }
              : approval;
        res.end(frame("RUN_FINISHED", { outcome: "interrupt", interrupt: pending }));
        return;
      }
      res.end(frame("RUN_FINISHED", { outcome: "success" }));
      return;
    }
    json(res, { error: "unexpected path" }, 404);
  };
  const server = createServer((req, res) => {
    void handler(req, res).catch((error) => {
      json(res, { error: String(error) }, 500);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const oauth = vi.fn(async () => "oauth-other-user");
  const deps: CaipeAcpDependencies = {
    getServerUrl: () => serverUrl,
    getAuthUrl: () => serverUrl,
    getValidToken: oauth,
    resolveSessionAgent: async () => ({ ...DEFAULT_AGENT, name: agentId }),
    buildSystemContext: async () => "",
    createAdapter,
    randomUUID,
  };
  return {
    serverUrl,
    conversations,
    messages,
    resumes,
    cancels,
    entered,
    streamClosed,
    oauth,
    setTokenStatus(status: number) {
      tokenStatus = status;
    },
    get tokenExchanges() {
      return tokenExchanges;
    },
    get creations() {
      return creations;
    },
    setMode(value: string) {
      mode = value;
    },
    bridge: () => new CaipeAcpAgent({ agentName: agentId, noContext: true, version: "test" }, deps),
    async close() {
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let server: Awaited<ReturnType<typeof fixture>>;
let configDir: string;
beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "caipe-acp-bff-"));
  vi.stubEnv("XDG_CONFIG_HOME", configDir);
  vi.stubEnv("CAIPE_TOKEN", "owner-token");
  delete process.env.CAIPE_API_KEY;
  delete process.env.CAIPE_CLIENT_ID;
  delete process.env.CAIPE_CLIENT_SECRET;
  server = await fixture();
});
afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

const prompt = (sessionId: string): acp.PromptRequest => ({
  sessionId,
  prompt: [{ type: "text" as const, text: "Check the service" }],
});
const workspace: acp.NewSessionRequest = { cwd: "/workspace", mcpServers: [] };

describe("ACP canonical BFF contract", () => {
  it("returns the BFF ID, persists idempotent canonical turns, and loads/replays without creating a thread", async () => {
    const updates: acp.SessionNotification[] = [];
    let id = "";
    await acp.client({ name: "app" }).connectWith(server.bridge().createApp(), async (agent) => {
      id = (await agent.request(acp.methods.agent.session.new, workspace)).sessionId;
      expect(server.conversations.has(id)).toBe(true);
      await agent.request(acp.methods.agent.session.prompt, prompt(id));
    });
    expect(server.messages.get(id)?.size).toBe(2);
    await acp
      .client({ name: "app-restarted" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      })
      .connectWith(server.bridge().createApp(), async (agent) => {
        await agent.request(acp.methods.agent.session.load, { ...workspace, sessionId: id });
        await agent.request(acp.methods.agent.session.prompt, prompt(id));
      });
    expect(server.creations).toBe(1);
    expect(server.messages.get(id)?.size).toBe(4);
    expect(updates.slice(0, 2).map((m) => m.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
    expect(server.oauth).not.toHaveBeenCalled();
  });

  it.each(["readonly", "agent", "missing", "autonomous"])(
    "rejects %s session load without allocating a replacement",
    async (failure) => {
      let id = "";
      await acp.client({ name: "app" }).connectWith(server.bridge().createApp(), async (agent) => {
        id = (await agent.request(acp.methods.agent.session.new, workspace)).sessionId;
      });
      const conversation = server.conversations.get(id);
      if (!conversation) throw new Error("missing conversation");
      if (failure === "readonly") vi.stubEnv("CAIPE_TOKEN", "readonly-token");
      if (failure === "agent") conversation.participants = [{ type: "agent", id: "other-agent" }];
      if (failure === "autonomous") conversation.source = "autonomous";
      if (failure === "missing") id = randomUUID();
      await expect(
        acp
          .client({ name: "app" })
          .connectWith(server.bridge().createApp(), async (agent) =>
            agent.request(acp.methods.agent.session.load, { ...workspace, sessionId: id }),
          ),
      ).rejects.toMatchObject({ code: -32603 });
      expect(server.creations).toBe(1);
    },
  );

  it("does not silently fall back to OAuth when an explicitly configured token is rejected", async () => {
    vi.stubEnv("CAIPE_TOKEN", "echo-sensitive-token");
    await expect(
      acp
        .client({ name: "app" })
        .connectWith(server.bridge().createApp(), async (agent) =>
          agent.request(acp.methods.agent.session.new, workspace),
        ),
    ).rejects.toMatchObject({
      code: -32000,
      message: expect.not.stringContaining("echo-sensitive-token"),
    });
    expect(server.oauth).not.toHaveBeenCalled();
    expect(server.creations).toBe(0);
  });

  it.each(["approve", "reject"])(
    "resumes native approval only after the client's selected %s option",
    async (choice) => {
      server.setMode("approval");
      const permissions: acp.RequestPermissionRequest[] = [];
      await acp
        .client({ name: "app" })
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
          permissions.push(params);
          return { outcome: { outcome: "selected", optionId: choice } };
        })
        .connectWith(server.bridge().createApp(), async (agent) => {
          const { sessionId } = await agent.request(acp.methods.agent.session.new, workspace);
          expect(
            await agent.request(acp.methods.agent.session.prompt, prompt(sessionId)),
          ).toMatchObject({ stopReason: "end_turn" });
          const rows = [...(server.messages.get(sessionId)?.values() ?? [])];
          expect(rows).toHaveLength(2);
          expect(rows[1]?.content).toBe("Partial answerPartial answer");
        });
      expect(permissions[0]?.toolCall.rawInput).toEqual(approval.payload.tool_args);
      expect(server.resumes).toEqual([{ type: "tool_approval", decision: choice }]);
    },
  );

  it("retains complete form schema across pause/load and negotiates the native input-required extension", async () => {
    server.setMode("form");
    let id = "";
    const nativeEvents: unknown[] = [];
    const client = () =>
      acp.client({ name: "app" }).onRequest(
        "_caipe/event",
        (params: unknown) => params,
        ({ params }) => {
          nativeEvents.push(params);
          return {};
        },
      );
    await client().connectWith(server.bridge().createApp(), async (agent) => {
      await agent.request(acp.methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { _meta: { "caipe.io/native-acp": 1 } },
      });
      id = (await agent.request(acp.methods.agent.session.new, workspace)).sessionId;
      const response = await agent.request(acp.methods.agent.session.prompt, prompt(id));
      expect(response).toMatchObject({
        stopReason: "refusal",
        _meta: {
          caipeStatus: "input_required",
          caipeConversationUrl: `${server.serverUrl}/chat/${id}`,
          caipePendingInterrupt: form,
        },
      });
    });
    await client().connectWith(server.bridge().createApp(), async (agent) => {
      await agent.request(acp.methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: { _meta: { "caipe.io/native-acp": 1 } },
      });
      await agent.request(acp.methods.agent.session.load, { ...workspace, sessionId: id });
      expect((await agent.request(acp.methods.agent.session.prompt, prompt(id))).stopReason).toBe(
        "refusal",
      );
    });
    expect(nativeEvents[0]).toMatchObject({
      sessionId: id,
      event: { kind: "input_required", fields: form.payload.fields, interrupt: form },
    });
    expect(nativeEvents).toHaveLength(3);
    expect(server.resumes).toEqual([]);
    expect(server.creations).toBe(1);
    const assistant = [...(server.messages.get(id)?.values() ?? [])].find(
      (m) => m.role === "assistant",
    );
    expect(assistant).toMatchObject({
      metadata: { turn_status: "waiting_for_input" },
      stream_events: [
        expect.objectContaining({
          inputRequiredData: expect.objectContaining({ fields: form.payload.fields }),
        }),
      ],
    });
  });

  it("rejects an invented permission option instead of approving it", async () => {
    server.setMode("approval");
    await expect(
      acp
        .client({ name: "app" })
        .onRequest(acp.methods.client.session.requestPermission, () => ({
          outcome: { outcome: "selected", optionId: "allow_everything" },
        }))
        .connectWith(server.bridge().createApp(), async (agent) => {
          const { sessionId } = await agent.request(acp.methods.agent.session.new, workspace);
          return agent.request(acp.methods.agent.session.prompt, prompt(sessionId));
        }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(server.resumes).toEqual([]);
  });

  it("cancels remotely and persists partial history before returning cancellation", async () => {
    server.setMode("block");
    const bridge = server.bridge();
    let tokenReceived = () => {};
    const received = new Promise<void>((resolve) => {
      tokenReceived = resolve;
    });
    await acp
      .client({ name: "app" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.update.sessionUpdate === "agent_message_chunk") tokenReceived();
      })
      .connectWith(bridge.createApp(), async (agent) => {
        const { sessionId } = await agent.request(acp.methods.agent.session.new, workspace);
        const response = agent.request(acp.methods.agent.session.prompt, prompt(sessionId));
        await received;
        await agent.notify(acp.methods.agent.session.cancel, { sessionId });
        expect(await response).toMatchObject({ stopReason: "cancelled" });
        expect(server.cancels).toEqual([sessionId]);
        expect(
          [...(server.messages.get(sessionId)?.values() ?? [])].find((m) => m.role === "assistant"),
        ).toMatchObject({ content: "Partial answer", metadata: { turn_status: "interrupted" } });
      });
    await server.streamClosed;
  });

  it("closes admission and drains remote cancellation when the connection closes", async () => {
    server.setMode("block");
    const bridge = server.bridge();
    await acp.client({ name: "app" }).connectWith(bridge.createApp(), async (agent) => {
      const { sessionId } = await agent.request(acp.methods.agent.session.new, workspace);
      const response = agent.request(acp.methods.agent.session.prompt, prompt(sessionId));
      await server.entered;
      await bridge.close();
      expect(await response).toMatchObject({ stopReason: "cancelled" });
      await expect(
        agent.request(acp.methods.agent.session.prompt, prompt(sessionId)),
      ).rejects.toMatchObject({ code: -32600 });
      expect(server.cancels).toEqual([sessionId]);
    });
  });
  it("keeps every tool's allowed decisions and batches only actual selected choices", async () => {
    server.setMode("approval_batch");
    let index = 0;
    await acp
      .client({ name: "app" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        if (++index === 1) return { outcome: { outcome: "selected", optionId: "approve" } };
        expect(params.options.map((option) => option.optionId)).toEqual(["reject"]);
        return { outcome: { outcome: "selected", optionId: "reject" } };
      })
      .connectWith(server.bridge().createApp(), async (agent) => {
        const { sessionId } = await agent.request(acp.methods.agent.session.new, workspace);
        expect(
          (await agent.request(acp.methods.agent.session.prompt, prompt(sessionId))).stopReason,
        ).toBe("end_turn");
      });
    expect(server.resumes).toEqual([
      { type: "tool_approval", decisions: [{ decision: "approve" }, { decision: "reject" }] },
    ]);
  });
  it("keeps cancelled/unsupported permission requests paused and does not resume", async () => {
    server.setMode("approval");
    await acp.client({ name: "app" }).connectWith(server.bridge().createApp(), async (agent) => {
      const { sessionId } = await agent.request(acp.methods.agent.session.new, workspace);
      expect(
        await agent.request(acp.methods.agent.session.prompt, prompt(sessionId)),
      ).toMatchObject({ stopReason: "refusal", _meta: { caipeStatus: "input_required" } });
    });
    expect(server.resumes).toEqual([]);
  });
  it("redacts configured credentials and Authorization bearer values from upstream errors", async () => {
    server.setMode("error");
    vi.stubEnv("CAIPE_CLIENT_SECRET", "echo-sensitive-token");
    await expect(
      acp.client({ name: "app" }).connectWith(server.bridge().createApp(), async (agent) => {
        const { sessionId } = await agent.request(acp.methods.agent.session.new, workspace);
        return agent.request(acp.methods.agent.session.prompt, prompt(sessionId));
      }),
    ).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("failed Authorization: Bearer [redacted] and [redacted]"),
    });
  });
});

describe("ACP stdio shutdown", () => {
  it.each(["EOF", "SIGTERM"])(
    "drains authenticated backend cancellation on %s",
    async (exitKind) => {
      server.setMode("block");
      const compiledBinary = process.env.CAIPE_TEST_BINARY;
      const child = spawn(
        compiledBinary ?? process.execPath,
        [
          ...(compiledBinary ? [] : ["--import", "tsx", "src/index.ts"]),
          "acp",
          "--agent",
          agentId,
          "--no-context",
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: {
            ...process.env,
            CAIPE_SERVER_URL: server.serverUrl,
            CAIPE_AUTH_URL: undefined,
            CAIPE_TOKEN: "owner-token",
          },
          stdio: "pipe",
        },
      );
      let diagnostics = "";
      child.stderr.on("data", (chunk) => {
        diagnostics += String(chunk);
      });
      let tokenReceived = () => {};
      const received = new Promise<void>((resolve) => {
        tokenReceived = resolve;
      });
      const connection = acp
        .client({ name: "stdio-app" })
        .onNotification(acp.methods.client.session.update, ({ params }) => {
          if (params.update.sessionUpdate === "agent_message_chunk") tokenReceived();
        })
        .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
      const exited = once(child, "exit");
      try {
        const initialized = await connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
        });
        expect(initialized.agentCapabilities?.loadSession).toBe(true);
        const { sessionId } = await connection.agent.request(
          acp.methods.agent.session.new,
          workspace,
        );
        await connection.agent.request(acp.methods.agent.session.load, { ...workspace, sessionId });
        expect(server.creations).toBe(1);
        const response = connection.agent
          .request(acp.methods.agent.session.prompt, prompt(sessionId))
          .catch(() => undefined);
        await received;
        if (exitKind === "EOF") child.stdin.end();
        else child.kill("SIGTERM");
        const [code, signal] = await exited;
        expect({ code, signal }).toEqual({ code: 0, signal: null });
        await response;
        expect(server.cancels).toEqual([sessionId]);
        expect(
          [...(server.messages.get(sessionId)?.values() ?? [])].find(
            (row) => row.role === "assistant",
          ),
        ).toMatchObject({ content: "Partial answer", metadata: { turn_status: "interrupted" } });
        expect(diagnostics).not.toContain("owner-token");
      } finally {
        connection.close();
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  );
});

describe("shared headless credential lifecycle", () => {
  it("uses OAuth only when headless credentials are absent", async () => {
    delete process.env.CAIPE_TOKEN;
    const fallback = vi.fn(async () => "oauth-token");
    expect(await createTokenProvider(server.serverUrl, fallback)()).toBe("oauth-token");
    expect(fallback).toHaveBeenCalledOnce();
  });
  it.each(["", " "])("rejects a configured empty token without OAuth fallback", async (token) => {
    vi.stubEnv("CAIPE_TOKEN", token);
    const fallback = vi.fn(async () => "oauth-token");
    await expect(createTokenProvider(server.serverUrl, fallback)()).rejects.toThrow(
      /configured but empty/,
    );
    expect(fallback).not.toHaveBeenCalled();
  });
  it("rejects incomplete client credentials without OAuth fallback", async () => {
    delete process.env.CAIPE_TOKEN;
    vi.stubEnv("CAIPE_CLIENT_ID", "worker");
    const fallback = vi.fn(async () => "oauth-token");
    await expect(createTokenProvider(server.serverUrl, fallback)()).rejects.toThrow(
      /both CAIPE_CLIENT_ID/,
    );
    expect(fallback).not.toHaveBeenCalled();
  });
  it("refreshes expiring client credentials and never falls back after a failed exchange", async () => {
    vi.stubEnv("CAIPE_TOKEN", undefined);
    vi.stubEnv("CAIPE_CLIENT_ID", "worker");
    vi.stubEnv("CAIPE_CLIENT_SECRET", "echo-sensitive-secret");
    const fallback = vi.fn(async () => "oauth-token");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const provider = createTokenProvider(server.serverUrl, fallback);
      expect(await provider()).toBe("owner-token");
      expect(await provider()).toBe("owner-token");
      expect(server.tokenExchanges).toBe(1);
      clock.mockReturnValue(now + 61_000);
      expect(await provider()).toBe("owner-token");
      expect(server.tokenExchanges).toBe(2);
      server.setTokenStatus(401);
      clock.mockReturnValue(now + 122_000);
      await expect(provider()).rejects.toThrow("Client credentials rejected (HTTP 401)");
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it("does not switch an admitted client-credentials session to OAuth when its configuration disappears", async () => {
    vi.stubEnv("CAIPE_TOKEN", undefined);
    vi.stubEnv("CAIPE_CLIENT_ID", "worker");
    vi.stubEnv("CAIPE_CLIENT_SECRET", "secret");
    const fallback = vi.fn(async () => "oauth-other-user");
    const provider = createTokenProvider(server.serverUrl, fallback);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(await provider()).toBe("owner-token");
      vi.stubEnv("CAIPE_CLIENT_ID", undefined);
      vi.stubEnv("CAIPE_CLIENT_SECRET", undefined);
      clock.mockReturnValue(now + 61_000);
      await expect(provider()).rejects.toThrow("Configured credentials are no longer available");
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
