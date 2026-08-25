import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { CaipeAcpAgent, type CaipeAcpDependencies, promptToText } from "../src/acp/server";
import type { Agent } from "../src/agents/types";
import { DEFAULT_AGENT } from "../src/agents/types";
import { AuthRequired } from "../src/auth/tokens";
import type { SendPayload, StreamAdapter, StreamEvent } from "../src/chat/stream";

const TEST_AGENT: Agent = { ...DEFAULT_AGENT, name: "test-agent", displayName: "Test Agent" };

function dependencies(
  adapterFactory: () => StreamAdapter,
  overrides: Partial<CaipeAcpDependencies> = {},
): CaipeAcpDependencies {
  let nextId = 0;
  return {
    getAuthUrl: () => "https://auth.example.test",
    getServerUrl: () => "https://caipe.example.test",
    getValidToken: async () => "token",
    resolveSessionAgent: async () => TEST_AGENT,
    buildSystemContext: async (cwd) => `context:${cwd}`,
    createAdapter: () => adapterFactory(),
    randomUUID: () => `id-${++nextId}`,
    ...overrides,
  };
}

function bridge(deps: CaipeAcpDependencies): CaipeAcpAgent {
  return new CaipeAcpAgent(
    { agentName: TEST_AGENT.name, version: "1.2.3", noContext: false },
    deps,
  );
}

function eventsAdapter(events: StreamEvent[], payloads: SendPayload[] = []): StreamAdapter {
  return {
    async *connect(payload) {
      payloads.push(payload);
      for (const event of events) yield event;
    },
  };
}

describe("CAIPE ACP agent", () => {
  it("negotiates ACP v1 and advertises terminal login only when supported", async () => {
    const app = bridge(dependencies(() => eventsAdapter([]))).createApp();

    const result = await acp.client({ name: "test-client" }).connectWith(app, async (agent) => {
      const withoutTerminal = await agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const withTerminal = await agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { auth: { terminal: true } },
      });
      return { withoutTerminal, withTerminal };
    });

    expect(result.withoutTerminal).toMatchObject({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {},
      },
      agentInfo: { name: "caipe-cli", title: "CAIPE", version: "1.2.3" },
      authMethods: [],
    });
    expect(result.withTerminal.authMethods).toEqual([
      expect.objectContaining({
        type: "terminal",
        id: "caipe-login",
        args: ["--login"],
      }),
    ]);
  });

  it("bridges text, resource links, conversations, and tool events", async () => {
    const payloads: SendPayload[] = [];
    const updates: acp.SessionNotification[] = [];
    const adapter = eventsAdapter(
      [
        { type: "conversation", conversationId: "conversation-1" },
        { type: "token", text: "Working" },
        { type: "tool", name: "search_files", toolCallId: "tool-1" },
        { type: "tool-args", toolCallId: "tool-1", delta: '{"query":"ACP"}' },
        { type: "tool-end", toolCallId: "tool-1" },
        { type: "tool-result", toolCallId: "tool-1", content: '{"matches":2}' },
        { type: "done" },
      ],
      payloads,
    );
    const app = bridge(dependencies(() => adapter)).createApp();

    const result = await acp
      .client({ name: "test-client" })
      .onNotification(acp.methods.client.session.update, (context) => {
        updates.push(context.params);
      })
      .connectWith(app, async (agent) => {
        const session = await agent.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        });
        const first = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [
            { type: "text", text: "Review this" },
            {
              type: "resource_link",
              name: "spec",
              title: "ACP specification",
              uri: "https://example.test/acp",
            },
          ],
        });
        const second = await agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "Continue" }],
        });
        return { first, second, session };
      });

    expect(result.first.stopReason).toBe("end_turn");
    expect(result.second.stopReason).toBe("end_turn");
    expect(payloads[0]).toMatchObject({
      prompt: "Review this\n\n[ACP specification](https://example.test/acp)",
      systemContext: "context:/workspace",
      agentName: "test-agent",
    });
    expect(payloads[1]?.conversationId).toBe("conversation-1");
    expect(updates.map((notification) => notification.update.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "tool_call_update",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "tool_call_update",
    ]);
    expect(updates[1]?.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      kind: "search",
      status: "in_progress",
    });
    expect(updates[2]?.update).toMatchObject({
      rawInput: { query: "ACP" },
    });
    expect(updates[3]?.update).toMatchObject({
      status: "completed",
      rawOutput: { matches: 2 },
    });
  });

  it("keeps concurrent sessions isolated", async () => {
    let adapterNumber = 0;
    const updates: acp.SessionNotification[] = [];
    const deps = dependencies(() => {
      const number = ++adapterNumber;
      return eventsAdapter([{ type: "token", text: `reply-${number}` }, { type: "done" }]);
    });
    const app = bridge(deps).createApp();

    const sessionIds = await acp
      .client({ name: "test-client" })
      .onNotification(acp.methods.client.session.update, (context) => {
        updates.push(context.params);
      })
      .connectWith(app, async (agent) => {
        const first = await agent.request(acp.methods.agent.session.new, {
          cwd: "/workspace/one",
          mcpServers: [],
        });
        const second = await agent.request(acp.methods.agent.session.new, {
          cwd: "/workspace/two",
          mcpServers: [],
        });
        await Promise.all([
          agent.request(acp.methods.agent.session.prompt, {
            sessionId: first.sessionId,
            prompt: [{ type: "text", text: "one" }],
          }),
          agent.request(acp.methods.agent.session.prompt, {
            sessionId: second.sessionId,
            prompt: [{ type: "text", text: "two" }],
          }),
        ]);
        return [first.sessionId, second.sessionId];
      });

    expect(sessionIds[0]).not.toBe(sessionIds[1]);
    expect(updates).toEqual([
      expect.objectContaining({
        sessionId: sessionIds[0],
        update: expect.objectContaining({ content: { type: "text", text: "reply-1" } }),
      }),
      expect.objectContaining({
        sessionId: sessionIds[1],
        update: expect.objectContaining({ content: { type: "text", text: "reply-2" } }),
      }),
    ]);
  });

  it("cancels the active CAIPE stream for one session", async () => {
    let streamStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    const adapter: StreamAdapter = {
      async *connect(payload) {
        streamStarted?.();
        await new Promise<void>((resolve) => {
          payload.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("aborted upstream stream");
      },
    };
    const app = bridge(dependencies(() => adapter)).createApp();

    const response = await acp.client({ name: "test-client" }).connectWith(app, async (agent) => {
      const session = await agent.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      const prompt = agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "wait" }],
      });
      await started;
      await agent.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      return prompt;
    });

    expect(response.stopReason).toBe("cancelled");
  });

  it("returns actionable protocol errors for auth, paths, MCP, and unsupported content", async () => {
    const authDeps = dependencies(() => eventsAdapter([]), {
      getValidToken: async () => {
        throw new AuthRequired();
      },
    });

    await expect(
      acp.client({ name: "test-client" }).connectWith(bridge(authDeps).createApp(), (agent) =>
        agent.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [],
        }),
      ),
    ).rejects.toMatchObject({ code: -32000, data: { loginCommand: "caipe auth login" } });

    const app = bridge(dependencies(() => eventsAdapter([{ type: "done" }]))).createApp();
    await acp.client({ name: "test-client" }).connectWith(app, async (agent) => {
      await expect(
        agent.request(acp.methods.agent.session.new, { cwd: "relative", mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        agent.request(acp.methods.agent.session.new, {
          cwd: "/workspace",
          mcpServers: [{ name: "local", command: "/bin/local-mcp", args: [], env: [] }],
        }),
      ).rejects.toThrow(/cannot yet be bridged/i);

      const session = await agent.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      await expect(
        agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        }),
      ).rejects.toThrow(/unsupported prompt content type/i);
    });
  });

  it("maps upstream CAIPE failures to JSON-RPC internal errors", async () => {
    const app = bridge(
      dependencies(() => eventsAdapter([{ type: "error", message: "upstream unavailable" }])),
    ).createApp();

    await acp.client({ name: "test-client" }).connectWith(app, async (agent) => {
      const session = await agent.request(acp.methods.agent.session.new, {
        cwd: "/workspace",
        mcpServers: [],
      });
      await expect(
        agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        }),
      ).rejects.toMatchObject({ code: -32603 });
    });
  });
});

describe("promptToText", () => {
  it("rejects empty prompts", () => {
    expect(() => promptToText([{ type: "text", text: "   " }])).toThrow(/must not be empty/);
  });
});
