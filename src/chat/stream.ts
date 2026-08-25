/**
 * AG-UI streaming adapter for dynamic agents.
 *
 * Calls POST <authUrl>/api/v1/chat/stream/start with body:
 *   { message, conversation_id, agent_id, protocol: "agui", client_context, context? }
 *
 * Each user turn prepends a `<client-context>` date block so agents resolve
 * "this week" / "today" without relying on model cutoff.
 *
 * Receives AG-UI SSE events and maps them to common StreamEvents consumed
 * by the REPL and headless runner.
 */
// assisted-by claude code claude-sonnet-4-6

import type { Agent } from "../agents/types.js";
import { clientUserFromTokenSet, formatClientContextBlock } from "./context.js";

// ---------------------------------------------------------------------------
// Common event types
// ---------------------------------------------------------------------------

export type StreamEventType =
  | "token"
  | "started"
  | "done"
  | "error"
  | "interrupted"
  | "tool"
  | "state";

export interface TokenEvent {
  type: "token";
  text: string;
}

export interface StartedEvent {
  type: "started";
  taskId?: string;
}

export interface DoneEvent {
  type: "done";
  response?: string;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

/** Agent paused for human input — not a failure; user should reply in the same session. */
export interface InterruptedEvent {
  type: "interrupted";
  reason?: string;
}

export interface ToolEvent {
  type: "tool";
  name: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
}

export interface ToolArgsEvent {
  type: "tool-args";
  toolCallId: string;
  delta: string;
}

export interface ToolEndEvent {
  type: "tool-end";
  toolCallId: string;
}

export interface ToolResultEvent {
  type: "tool-result";
  toolCallId: string;
  content: string;
}

export interface StateEvent {
  type: "state";
  data: unknown;
}

export type StreamEvent =
  | TokenEvent
  | StartedEvent
  | DoneEvent
  | ErrorEvent
  | InterruptedEvent
  | ToolEvent
  | ToolArgsEvent
  | ToolEndEvent
  | ToolResultEvent
  | StateEvent
  | ConversationEvent;

// ---------------------------------------------------------------------------
// StreamAdapter interface
// ---------------------------------------------------------------------------

export interface SendPayload {
  prompt: string;
  systemContext?: string;
  sessionId: string;
  /** Restored from session file on resume; skips creating a new BFF conversation. */
  conversationId?: string;
  agentName: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ConversationEvent {
  type: "conversation";
  conversationId: string;
}

export interface StreamAdapter {
  /**
   * Connect to the agent and yield StreamEvents.
   */
  connect(payload: SendPayload): AsyncIterable<StreamEvent>;
}

function conversationCreateError(status: number, bodyText: string, agentId: string): Error {
  try {
    const body = JSON.parse(bodyText) as { code?: string; error?: string; reason?: string };
    if (status === 403 && body.code === "agent#use") {
      return new Error(
        `Permission denied for agent "${agentId}" (OpenFGA agent#use). Run \`caipe agents list\` and use \`caipe chat --agent <id>\` for an agent you can access, or ask an admin to grant use on this agent.`,
      );
    }
    if (body.error) {
      return new Error(`Failed to create conversation (${status}): ${body.error}`);
    }
  } catch {
    /* fall through */
  }
  return new Error(`Failed to create conversation (${status}): ${bodyText}`);
}

function shouldTryNextClientType(status: number, bodyText: string): boolean {
  return status === 400 && bodyText.includes("Invalid client_type");
}

// ---------------------------------------------------------------------------
// AG-UI adapter — direct fetch to /api/v1/chat/stream/start
// ---------------------------------------------------------------------------

/**
 * Calls the dynamic agents streaming endpoint via the caipe-ui BFF.
 *
 * Body: { message, conversation_id, agent_id, protocol: "agui", client_context: { source: "cli" } }
 * Events: AG-UI SSE — RUN_STARTED, TEXT_MESSAGE_CONTENT, TOOL_CALL_START,
 *         TOOL_CALL_END, RUN_FINISHED, RUN_ERROR, CUSTOM
 */
export interface AdapterOptions {
  /** Pre-seed sessionId → BFF conversation _id (from saved session on resume). */
  conversationIds?: Record<string, string>;
}

export class AguiAdapter implements StreamAdapter {
  // Maps local sessionId → server-assigned conversation _id
  private readonly conversationIds = new Map<string, string>();

  constructor(
    private readonly agent: Agent,
    /** Full URL of the stream endpoint (e.g. http://localhost:3000/api/v1/chat/stream/start) */
    private readonly streamEndpoint: string,
    private readonly getAccessToken: () => Promise<string>,
    options?: AdapterOptions,
  ) {
    if (options?.conversationIds) {
      for (const [sessionId, id] of Object.entries(options.conversationIds)) {
        this.conversationIds.set(sessionId, id);
      }
    }
  }

  /**
   * Ensure the conversation exists in the BFF before streaming.
   * Returns the server-assigned conversation _id to use in subsequent stream calls.
   */
  private async ensureConversation(
    sessionId: string,
    agentId: string,
    token: string,
    persistedId?: string,
  ): Promise<string> {
    if (persistedId) {
      this.conversationIds.set(sessionId, persistedId);
      return persistedId;
    }
    const cached = this.conversationIds.get(sessionId);
    if (cached) return cached;

    // Derive conversations URL from stream endpoint:
    // http://localhost:3000/api/v1/chat/stream/start → http://localhost:3000/api/chat/conversations
    const base = this.streamEndpoint.replace(/\/api\/v1\/chat\/stream\/start$/, "");
    const url = `${base}/api/chat/conversations`;

    try {
      const attempts: Array<{ client_type: "slack" | "cli"; metadata: Record<string, unknown> }> = [
        { client_type: "slack", metadata: { source: "caipe-cli", bridged_as: "slack" } },
        { client_type: "cli", metadata: { source: "caipe-cli" } },
      ];
      let res: Response | undefined;
      let lastError = "";

      for (const attempt of attempts) {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: "CLI session",
            client_type: attempt.client_type,
            agent_id: agentId,
            metadata: attempt.metadata,
          }),
        });
        if (res.ok) break;

        const text = await res.text().catch(() => "");
        lastError = text;
        if (shouldTryNextClientType(res.status, text)) continue;
        throw conversationCreateError(res.status, text, agentId);
      }

      if (!res?.ok) {
        throw conversationCreateError(res?.status ?? 0, lastError, agentId);
      }
      const json = (await res.json()) as { data?: { conversation?: { _id?: string } } };
      const serverId = json?.data?.conversation?._id;
      if (!serverId) throw new Error("Server did not return conversation _id");
      this.conversationIds.set(sessionId, serverId);
      return serverId;
    } catch (err) {
      throw new Error(
        `Conversation setup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async *connect(payload: SendPayload): AsyncIterable<StreamEvent> {
    const token = await this.getAccessToken();
    const agentId = this.agent.name;

    let conversationId: string;
    try {
      conversationId = await this.ensureConversation(
        payload.sessionId,
        agentId,
        token,
        payload.conversationId,
      );
    } catch (err) {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    yield { type: "conversation", conversationId };

    const userText = payload.prompt.trim();
    const { loadTokens } = await import("../auth/keychain.js");
    const sessionUser = clientUserFromTokenSet(await loadTokens());
    const withClock = userText.includes("<client-context>")
      ? userText
      : `${formatClientContextBlock({ user: sessionUser })}\n\n${userText}`;

    const bodyObj: Record<string, unknown> = {
      message: withClock,
      conversation_id: conversationId,
      agent_id: agentId,
      protocol: "agui",
      client_context: { source: "cli" },
    };
    const ctx = payload.systemContext?.trim();
    if (ctx) bodyObj.context = ctx;

    const body = JSON.stringify(bodyObj);

    const res = await fetch(this.streamEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body,
    });

    if (!res.ok) {
      yield {
        type: "error",
        message: `Stream request failed: ${res.status} ${res.statusText}`,
      };
      return;
    }

    if (!res.body) {
      yield { type: "error", message: "No response body" };
      return;
    }

    yield { type: "started" };
    yield* this.parseSSE(res.body);
  }

  private async *parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Current SSE frame fields
    let eventType = "";
    let dataLines: string[] = [];
    let fullText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          } else if (line === "") {
            // Blank line — dispatch accumulated frame
            if (dataLines.length > 0) {
              const raw = dataLines.join("\n");
              dataLines = [];
              const et = eventType;
              eventType = "";

              let parsed: Record<string, unknown>;
              try {
                parsed = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                continue;
              }

              const ev = this.mapEvent(et || (parsed.type as string) || "", parsed);
              if (ev) {
                if (ev.type === "token") fullText += (ev as TokenEvent).text;
                yield ev;
                if (ev.type === "done" || ev.type === "error") return;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", response: fullText };
  }

  private mapEvent(eventType: string, parsed: Record<string, unknown>): StreamEvent | null {
    switch (eventType) {
      case "RUN_STARTED":
        return { type: "started", taskId: (parsed.runId as string | undefined) ?? undefined };

      case "TEXT_MESSAGE_START":
      case "TEXT_MESSAGE_END":
        return null;

      case "TEXT_MESSAGE_CONTENT":
        return { type: "token", text: (parsed.delta as string) ?? "" };

      case "TOOL_CALL_START":
        return {
          type: "tool",
          name: (parsed.toolCallName as string) ?? "unknown",
          toolCallId: (parsed.toolCallId as string) ?? undefined,
        };

      case "TOOL_CALL_ARGS": {
        const toolCallId = (parsed.toolCallId as string) ?? "";
        const delta = (parsed.delta as string) ?? "";
        if (!toolCallId || !delta) return null;
        return { type: "tool-args", toolCallId, delta };
      }

      case "TOOL_CALL_END": {
        const toolCallId = (parsed.toolCallId as string) ?? "";
        if (!toolCallId) return null;
        return { type: "tool-end", toolCallId };
      }

      case "TOOL_CALL_RESULT": {
        const toolCallId = (parsed.toolCallId as string) ?? "";
        const content = (parsed.content as string) ?? "";
        if (!toolCallId || !content) return null;
        return { type: "tool-result", toolCallId, content };
      }

      case "RUN_FINISHED": {
        const outcome = parsed.outcome as string | undefined;
        if (outcome === "interrupt") {
          const interrupt = parsed.interrupt as Record<string, unknown> | undefined;
          const reason = interrupt?.reason as string | undefined;
          return { type: "interrupted", reason };
        }
        return { type: "done" };
      }

      case "RUN_ERROR":
        return {
          type: "error",
          message: (parsed.message as string) ?? "Unknown error",
        };

      case "CUSTOM": {
        const name = parsed.name as string | undefined;
        if (name === "WARNING") {
          const val = parsed.value as Record<string, unknown> | undefined;
          // Emit warnings as tokens so they appear inline
          return { type: "token", text: `\n> ⚠ ${(val?.message as string) ?? ""}` };
        }
        if (name === "INPUT_REQUIRED") {
          return { type: "interrupted" };
        }
        return null;
      }

      default:
        return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an AG-UI StreamAdapter.
 *
 * @param agent        The target CAIPE server agent
 * @param streamEndpoint Full URL of the stream/start endpoint
 * @param getAccessToken Async function returning a live Bearer token
 */
export function createAdapter(
  agent: Agent,
  streamEndpoint: string,
  getAccessToken: () => Promise<string>,
  options?: AdapterOptions,
): StreamAdapter {
  return new AguiAdapter(agent, streamEndpoint, getAccessToken, options);
}
