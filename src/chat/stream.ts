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

import { randomUUID } from "node:crypto";
import type { Agent } from "../agents/types.js";
import { AuthRequired } from "../auth/tokens.js";
import type { ClientUserContext } from "./context.js";
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
  /** Complete server payload, including form schema and every tool approval. */
  interrupt?: Record<string, unknown>;
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
  /** Cancels conversation creation and the active AG-UI stream. */
  signal?: AbortSignal;
  /** Explicit native HITL response; sent to stream/resume instead of starting a turn. */
  resumeData?: Record<string, unknown>;
  /** One canonical assistant row across an initial stream and immediate approval resumes. */
  transcript?: TranscriptTurn;
}

export interface TranscriptTurn {
  id: string;
  content: string;
  events: Array<Record<string, unknown>>;
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

export interface ConversationHistoryMessage {
  _id?: string;
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LoadedConversation {
  conversationId: string;
  messages: ConversationHistoryMessage[];
  interrupt?: Record<string, unknown>;
}

/** The existing BFF owns identity, access checks, conversation IDs and native state. */
export interface ConversationAdapter extends StreamAdapter {
  createConversation(signal?: AbortSignal): Promise<string>;
  loadConversation(conversationId: string, signal?: AbortSignal): Promise<LoadedConversation>;
  cancelConversation(conversationId: string): Promise<boolean>;
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
  /** Explicitly use {} for headless callers; never borrow another user's stored OAuth identity. */
  clientUser?: ClientUserContext;
  /** ACP clients write their own turns through the same message upsert API as the browser. */
  persistHistory?: boolean;
}

export class AguiAdapter implements ConversationAdapter {
  // Maps local sessionId → server-assigned conversation _id
  private readonly conversationIds = new Map<string, string>();

  constructor(
    private readonly agent: Agent,
    /** Full URL of the stream endpoint (e.g. http://localhost:3000/api/v1/chat/stream/start) */
    private readonly streamEndpoint: string,
    private readonly getAccessToken: () => Promise<string>,
    private readonly options?: AdapterOptions,
  ) {
    if (options?.conversationIds) {
      for (const [sessionId, id] of Object.entries(options.conversationIds)) {
        this.conversationIds.set(sessionId, id);
      }
    }
  }

  private get baseUrl(): string {
    return this.streamEndpoint.replace(/\/api\/v1\/chat\/stream\/start$/, "");
  }

  private async requestJson(
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
    accessToken?: string,
  ): Promise<Record<string, unknown>> {
    const token = accessToken ?? (await this.getAccessToken());
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal ?? AbortSignal.timeout(10_000),
    });
    if (response.status === 401)
      throw new AuthRequired("CAIPE rejected the configured credentials (HTTP 401).");
    if (!response.ok) {
      if (response.status === 403) {
        const error = (await response.json().catch(() => undefined)) as
          | { code?: string }
          | undefined;
        if (error?.code === "agent#use")
          throw new Error(
            `Permission denied for agent "${this.agent.name}". Run \`caipe agents list\` or ask an administrator to grant agent use.`,
          );
      }
      throw new Error(`CAIPE conversation request failed (HTTP ${response.status}).`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async createConversation(signal?: AbortSignal): Promise<string> {
    const token = await this.getAccessToken();
    return this.ensureConversation(randomUUID(), this.agent.name, token, undefined, signal);
  }

  async loadConversation(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<LoadedConversation> {
    const path = `/api/chat/conversations/${encodeURIComponent(conversationId)}`;
    const result = await this.requestJson(path, { signal });
    const conversation = result.data as Record<string, unknown> | undefined;
    const participants = conversation?.participants as
      | Array<{ type: string; id: string }>
      | undefined;
    const agentIds = participants?.filter((p) => p.type === "agent").map((p) => p.id) ?? [];
    if (
      conversation?._id !== conversationId ||
      !["owner", "shared"].includes(String(conversation.access_level)) ||
      conversation.source === "autonomous" ||
      agentIds.length !== 1 ||
      agentIds[0] !== this.agent.name
    ) {
      throw new Error(
        "This conversation is not writable by the current caller for the selected agent.",
      );
    }

    const messages: ConversationHistoryMessage[] = [];
    let completed = false;
    for (let page = 1; page <= 100; page++) {
      const history = await this.requestJson(`${path}/messages?page=${page}&page_size=100`, {
        signal,
      });
      const data = history.data as
        | { items?: ConversationHistoryMessage[]; has_more?: boolean }
        | undefined;
      if (!Array.isArray(data?.items))
        throw new Error("CAIPE returned an invalid conversation history.");
      messages.push(...data.items);
      if (!data.has_more) {
        completed = true;
        break;
      }
    }
    if (!completed)
      throw new Error("Conversation history exceeds the ACP replay limit; open it in CAIPE.");

    const state = await this.requestJson(
      `/api/dynamic-agents/conversations/${encodeURIComponent(conversationId)}/interrupt-state?agent_id=${encodeURIComponent(this.agent.name)}`,
      { signal },
    );
    const nativeInterrupt = state.has_pending_interrupt
      ? (state.interrupt_data as Record<string, unknown> | undefined)
      : undefined;
    const interrupt = nativeInterrupt
      ? {
          id: nativeInterrupt.interrupt_id,
          reason: nativeInterrupt.type === "tool_approval" ? "tool_approval" : "human_input",
          payload: nativeInterrupt,
        }
      : undefined;
    this.conversationIds.set(conversationId, conversationId);
    return { conversationId, messages, interrupt };
  }

  async cancelConversation(conversationId: string): Promise<boolean> {
    const result = await this.requestJson("/api/v1/chat/stream/cancel", {
      method: "POST",
      body: { conversation_id: conversationId, agent_id: this.agent.name },
      signal: AbortSignal.timeout(5_000),
    });
    return result.cancelled === true;
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
    signal?: AbortSignal,
  ): Promise<string> {
    if (persistedId) {
      this.conversationIds.set(sessionId, persistedId);
      return persistedId;
    }
    const cached = this.conversationIds.get(sessionId);
    if (cached) return cached;

    const json = await this.requestJson(
      "/api/chat/conversations",
      {
        method: "POST",
        signal,
        body: {
          title: "CLI session",
          client_type: "api",
          agent_id: agentId,
          metadata: { source: "caipe-cli" },
        },
      },
      token,
    );
    const data = json.data as { conversation?: { _id?: string } } | undefined;
    const serverId = data?.conversation?._id;
    if (!serverId) throw new Error("Server did not return a conversation ID.");
    this.conversationIds.set(sessionId, serverId);
    return serverId;
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
        payload.signal,
      );
    } catch (err) {
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    yield { type: "conversation", conversationId };

    const transcript = payload.transcript ?? { id: randomUUID(), content: "", events: [] };
    const historyPath = `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`;
    if (this.options?.persistHistory && payload.resumeData === undefined) {
      await this.requestJson(historyPath, {
        method: "POST",
        signal: payload.signal,
        body: {
          message_id: `${transcript.id}-user`,
          role: "user",
          content: payload.prompt,
          metadata: {
            turn_id: transcript.id,
            source: "caipe-cli",
            agent_id: agentId,
            is_final: true,
          },
        },
      });
    }

    const userText = payload.prompt.trim();
    const { loadTokens } = await import("../auth/keychain.js");
    const sessionUser = this.options?.clientUser ?? clientUserFromTokenSet(await loadTokens());
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
    if (payload.resumeData !== undefined) {
      delete bodyObj.message;
      bodyObj.resume_data = JSON.stringify(payload.resumeData);
    }

    const body = JSON.stringify(bodyObj);

    const endpoint =
      payload.resumeData === undefined
        ? this.streamEndpoint
        : `${this.baseUrl}/api/v1/chat/stream/resume`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body,
      signal: payload.signal,
    });

    if (!res.ok) {
      if (res.status === 401)
        throw new AuthRequired("CAIPE rejected the configured credentials (HTTP 401).");
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
    let status = "interrupted";
    try {
      for await (const event of this.parseSSE(res.body)) {
        if (event.type === "token") transcript.content += event.text;
        if (event.type === "interrupted") {
          status = "waiting_for_input";
          const interrupt = event.interrupt ?? { reason: event.reason };
          const value = (interrupt.payload ?? {}) as Record<string, unknown>;
          transcript.events.push({
            type: "input_required",
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            namespace: [],
            inputRequiredData: {
              ...value,
              interrupt_id: interrupt.id,
              type: event.reason === "tool_approval" ? "tool_approval" : "form_input",
            },
          });
        } else if (event.type === "done") status = "done";
        else if (event.type === "tool")
          transcript.events.push({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            namespace: [],
            type: "tool_start",
            toolData: { tool_name: event.name, tool_call_id: event.toolCallId, args: event.input },
          });
        else if (event.type === "tool-result")
          transcript.events.push({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            namespace: [],
            type: "tool_end",
            toolData: { tool_call_id: event.toolCallId, result: event.content },
          });
        yield event;
      }
    } finally {
      if (this.options?.persistHistory) {
        await this.requestJson(historyPath, {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
          body: {
            message_id: `${transcript.id}-assistant`,
            role: "assistant",
            content: transcript.content,
            metadata: {
              turn_id: transcript.id,
              source: "caipe-cli",
              agent_id: agentId,
              is_final: true,
              turn_status: status,
              is_interrupted: status !== "done",
            },
            stream_events: transcript.events,
          },
        });
      }
    }
  }

  private async *parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Current SSE frame fields
    let eventType = "";
    let dataLines: string[] = [];

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
                yield ev;
                if (ev.type === "done" || ev.type === "error" || ev.type === "interrupted") return;
              }
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    yield {
      type: "error",
      message: "CAIPE stream closed before a terminal event; check the conversation in CAIPE.",
    };
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
          return { type: "interrupted", reason, interrupt };
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
          const value = parsed.value as Record<string, unknown> | undefined;
          return {
            type: "interrupted",
            reason: value?.type === "tool_approval" ? "tool_approval" : "human_input",
            interrupt: { payload: value },
          };
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
): ConversationAdapter {
  return new AguiAdapter(agent, streamEndpoint, getAccessToken, options);
}
