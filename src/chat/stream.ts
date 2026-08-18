/**
 * AG-UI streaming adapter for dynamic agents.
 *
 * Calls POST <authUrl>/api/v1/chat/stream/start with body:
 *   { message, conversation_id, agent_id, protocol: "agui", context? }
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
  harnessId?: string;
  replayed?: boolean;
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
 * Body: { message, conversation_id, agent_id, protocol: "agui" }
 * Events: AG-UI SSE — RUN_STARTED, TEXT_MESSAGE_CONTENT, TOOL_CALL_START,
 *         TOOL_CALL_END, RUN_FINISHED, RUN_ERROR, CUSTOM
 */
export interface AdapterOptions {
  /** Pre-seed sessionId → BFF conversation _id (from saved session on resume). */
  conversationIds?: Record<string, string>;
}

interface ReplayState {
  lastEventId: number;
  terminal: boolean;
  fullText: string;
  seen: Set<string>;
}

interface MappedEvent {
  event: StreamEvent;
  key: string;
  terminal?: boolean;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 250;

function reconnectDelay(attempt: number): Promise<void> {
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), 4_000);
  return new Promise((resolve) => setTimeout(resolve, delay));
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
    };
    const ctx = payload.systemContext?.trim();
    if (ctx) bodyObj.context = ctx;

    const body = JSON.stringify(bodyObj);

    let res: Response;
    try {
      res = await fetch(this.streamEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body,
      });
    } catch (err) {
      yield {
        type: "error",
        message: `Stream request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

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

    const runId = res.headers.get("X-Harness-Run-ID")?.trim() || undefined;
    const harnessId = res.headers.get("X-Harness-ID")?.trim() || this.agent.harnessId;
    const state: ReplayState = {
      lastEventId: 0,
      terminal: false,
      fullText: "",
      seen: new Set(),
    };

    yield { type: "started", taskId: runId, harnessId };
    try {
      yield* this.parseSSE(res.body, "agui", state);
    } catch (err) {
      if (!runId) {
        yield {
          type: "error",
          message: `Stream interrupted: ${err instanceof Error ? err.message : String(err)}`,
        };
        return;
      }
    }

    if (state.terminal) return;
    if (!runId) {
      // Preserve the historical Dynamic Agents behavior for streams that end
      // without an explicit terminal frame.
      yield { type: "done", response: state.fullText };
      return;
    }

    const replayUrl = this.replayEndpoint(runId);
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      await reconnectDelay(attempt);
      let replay: Response;
      try {
        const replayToken = await this.getAccessToken();
        replay = await fetch(replayUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${replayToken}`,
            Accept: "text/event-stream",
            // Rewind one canonical sequence. A translated AG-UI sequence can
            // contain multiple frames, so replaying the last sequence plus
            // semantic de-duplication prevents a mid-frame-group gap.
            "Last-Event-ID": String(Math.max(0, state.lastEventId - 1)),
          },
        });
      } catch {
        continue;
      }

      if (!replay.ok || !replay.body) {
        if (replay.status < 500 && replay.status !== 408 && replay.status !== 429) break;
        continue;
      }

      yield { type: "started", taskId: runId, harnessId, replayed: true };
      try {
        yield* this.parseSSE(replay.body, "canonical", state);
      } catch {
        // The detached run is still owned by Harness Engine. Retry this same
        // run from the last durable cursor; never submit the prompt again.
      }
      if (state.terminal) return;
    }

    yield {
      type: "error",
      message: `Harness run ${runId} is still active, but its event stream could not be resumed`,
    };
  }

  private replayEndpoint(runId: string): string {
    const base = this.streamEndpoint.replace(/\/api\/v1\/chat\/stream\/start$/, "");
    return `${base}/api/harness-engine/runs/${encodeURIComponent(runId)}/events/stream`;
  }

  private async *parseSSE(
    body: ReadableStream<Uint8Array>,
    protocol: "agui" | "canonical",
    state: ReplayState,
  ): AsyncIterable<StreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Current SSE frame fields
    let eventType = "";
    let eventId = 0;
    let dataLines: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("id:")) {
            eventId = Number.parseInt(line.slice(3).trim(), 10) || 0;
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

              const mapped = this.mapEvents(protocol, et || (parsed.type as string) || "", parsed);
              for (const item of mapped) {
                const key = eventId > 0 ? `${eventId}:${item.key}` : "";
                if (key && state.seen.has(key)) continue;
                if (key) state.seen.add(key);
                if (item.event.type === "token") state.fullText += item.event.text;
                if (item.terminal) state.terminal = true;
                yield item.event;
                if (item.terminal) return;
              }
              if (eventId > 0) state.lastEventId = Math.max(state.lastEventId, eventId);
              eventId = 0;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private mapEvents(
    protocol: "agui" | "canonical",
    eventType: string,
    parsed: Record<string, unknown>,
  ): MappedEvent[] {
    return protocol === "canonical"
      ? this.mapCanonicalEvent(eventType, parsed)
      : this.mapAguiEvent(eventType, parsed);
  }

  private mapAguiEvent(eventType: string, parsed: Record<string, unknown>): MappedEvent[] {
    switch (eventType) {
      case "RUN_STARTED":
        return [
          {
            event: { type: "started", taskId: (parsed.runId as string | undefined) ?? undefined },
            key: "run.started",
          },
        ];

      case "TEXT_MESSAGE_START":
      case "TEXT_MESSAGE_END":
        return [];

      case "TEXT_MESSAGE_CONTENT":
        return [
          {
            event: { type: "token", text: (parsed.delta as string) ?? "" },
            key: "content.delta",
          },
        ];

      case "TOOL_CALL_START":
        return [
          {
            event: {
              type: "tool",
              name: (parsed.toolCallName as string) ?? "unknown",
              toolCallId: (parsed.toolCallId as string) ?? undefined,
            },
            key: "tool.started:start",
          },
        ];

      case "TOOL_CALL_ARGS": {
        const toolCallId = (parsed.toolCallId as string) ?? "";
        const delta = (parsed.delta as string) ?? "";
        if (!toolCallId || !delta) return [];
        return [{ event: { type: "tool-args", toolCallId, delta }, key: "tool.started:args" }];
      }

      case "TOOL_CALL_END": {
        const toolCallId = (parsed.toolCallId as string) ?? "";
        if (!toolCallId) return [];
        return [{ event: { type: "tool-end", toolCallId }, key: "tool.completed:end" }];
      }

      case "TOOL_CALL_RESULT": {
        const toolCallId = (parsed.toolCallId as string) ?? (parsed.tool_call_id as string) ?? "";
        const rawContent = parsed.content ?? parsed.result ?? "";
        const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
        if (!toolCallId || !content) return [];
        return [
          { event: { type: "tool-result", toolCallId, content }, key: "tool.completed:result" },
        ];
      }

      case "RUN_FINISHED": {
        const outcome = parsed.outcome as string | undefined;
        if (outcome === "interrupt") {
          const interrupt = parsed.interrupt as Record<string, unknown> | undefined;
          const reason = interrupt?.reason as string | undefined;
          return [
            {
              event: { type: "interrupted", reason },
              key: "interrupt.requested",
              terminal: true,
            },
          ];
        }
        return [
          {
            event: { type: "done" },
            key: outcome === "cancelled" ? "run.cancelled" : "run.completed",
            terminal: true,
          },
        ];
      }

      case "RUN_ERROR":
        return [
          {
            event: {
              type: "error",
              message: (parsed.message as string) ?? "Unknown error",
            },
            key: "run.failed",
            terminal: true,
          },
        ];

      case "CUSTOM": {
        const name = parsed.name as string | undefined;
        if (name === "WARNING") {
          const val = parsed.value as Record<string, unknown> | undefined;
          // Emit warnings as tokens so they appear inline
          return [
            {
              event: { type: "token", text: `\n> ⚠ ${(val?.message as string) ?? ""}` },
              key: "warning",
            },
          ];
        }
        if (name === "INPUT_REQUIRED") {
          return [
            {
              event: { type: "interrupted" },
              key: "interrupt.requested",
              terminal: true,
            },
          ];
        }
        return [];
      }

      default:
        return [];
    }
  }

  private mapCanonicalEvent(eventType: string, parsed: Record<string, unknown>): MappedEvent[] {
    const stringField = (...names: string[]): string => {
      for (const name of names) {
        const value = parsed[name];
        if (typeof value === "string") return value;
      }
      return "";
    };

    switch (eventType) {
      case "run.started":
        return [{ event: { type: "started" }, key: "run.started" }];
      case "content.delta":
        return [
          { event: { type: "token", text: stringField("text", "delta") }, key: "content.delta" },
        ];
      case "tool.started": {
        const toolCallId = stringField("tool_call_id", "id");
        const events: MappedEvent[] = [
          {
            event: {
              type: "tool",
              name: stringField("tool_name", "name") || "unknown",
              toolCallId: toolCallId || undefined,
            },
            key: "tool.started:start",
          },
        ];
        if (toolCallId && parsed.arguments !== undefined) {
          events.push({
            event: {
              type: "tool-args",
              toolCallId,
              delta:
                typeof parsed.arguments === "string"
                  ? parsed.arguments
                  : JSON.stringify(parsed.arguments),
            },
            key: "tool.started:args",
          });
        }
        return events;
      }
      case "tool.completed": {
        const toolCallId = stringField("tool_call_id", "id");
        if (!toolCallId) return [];
        const rawContent = parsed.result ?? parsed.content ?? "";
        const content = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
        return [
          {
            event: { type: "tool-result", toolCallId, content },
            key: "tool.completed:result",
          },
          { event: { type: "tool-end", toolCallId }, key: "tool.completed:end" },
        ];
      }
      case "interrupt.requested":
        return [
          {
            event: {
              type: "interrupted",
              reason:
                stringField("reason") ||
                (parsed.interrupt_type === "tool_approval" ? "tool_approval" : "human_input"),
            },
            key: "interrupt.requested",
            terminal: true,
          },
        ];
      case "run.completed":
        return [{ event: { type: "done" }, key: "run.completed", terminal: true }];
      case "run.cancelled":
        return [{ event: { type: "done" }, key: "run.cancelled", terminal: true }];
      case "run.failed":
        return [
          {
            event: {
              type: "error",
              message: stringField("message") || "Harness execution failed",
            },
            key: "run.failed",
            terminal: true,
          },
        ];
      default:
        return [];
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
