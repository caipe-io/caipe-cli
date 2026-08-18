import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "../src/agents/types.js";
import { AguiAdapter } from "../src/chat/stream.js";

const agent: Agent = {
  name: "agent-example",
  displayName: "Example Agent",
  description: "Harness Engine contract test",
  endpoint: "",
  protocols: ["agui"],
  available: true,
  domain: "general",
  harnessId: "claude_agent_sdk",
  harnessName: "Claude Agent SDK",
};

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("Harness Engine HTTP stream contract", () => {
  it("forwards context and replays a disconnected detached run over real HTTP", async () => {
    const requests: Array<{
      method: string;
      path: string;
      lastEventId?: string;
      body?: Record<string, unknown>;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        requests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          lastEventId:
            typeof request.headers["last-event-id"] === "string"
              ? request.headers["last-event-id"]
              : undefined,
          body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined,
        });

        if (request.method === "POST" && request.url === "/api/v1/chat/stream/start") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "X-Harness-Run-ID": "run-e2e",
            "X-Harness-ID": "claude_agent_sdk",
          });
          response.end(
            'id: 1\nevent: RUN_STARTED\ndata: {"type":"RUN_STARTED","runId":"run-e2e"}\n\n' +
              'id: 2\nevent: TEXT_MESSAGE_CONTENT\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"first "}\n\n',
          );
          return;
        }

        if (
          request.method === "GET" &&
          request.url === "/api/harness-engine/runs/run-e2e/events/stream"
        ) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(
            'id: 2\nevent: content.delta\ndata: {"text":"first "}\n\n' +
              'id: 3\nevent: content.delta\ndata: {"text":"second"}\n\n' +
              "id: 4\nevent: run.completed\ndata: {}\n\n",
          );
          return;
        }

        response.writeHead(404).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const adapter = new AguiAdapter(
      agent,
      `http://127.0.0.1:${port}/api/v1/chat/stream/start`,
      async () => "test-token",
    );

    const events = [];
    for await (const event of adapter.connect({
      prompt: "hello",
      systemContext: "portable client context",
      sessionId: "session-e2e",
      conversationId: "conversation-e2e",
      agentName: agent.name,
    })) {
      events.push(event);
    }

    expect(
      events
        .filter((event) => event.type === "token")
        .map((event) => (event as { text: string }).text)
        .join(""),
    ).toBe("first second");
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/chat/stream/start",
      body: {
        agent_id: "agent-example",
        conversation_id: "conversation-e2e",
        context: "portable client context",
      },
    });
    expect(requests[1]).toMatchObject({
      method: "GET",
      path: "/api/harness-engine/runs/run-e2e/events/stream",
      lastEventId: "1",
    });
  });
});
