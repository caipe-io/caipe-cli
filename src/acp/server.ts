/**
 * ACP v1 agent adapter for CAIPE.
 *
 * The editor sees this process as an ACP agent. Each ACP session is bridged to
 * an independent CAIPE AG-UI conversation while auth, agent resolution, and
 * repository context continue to use the canonical CLI implementations.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { resolveSessionAgent } from "../agents/registry.js";
import type { Agent } from "../agents/types.js";
import { AuthRequired, getValidToken } from "../auth/tokens.js";
import { buildSystemContext } from "../chat/context.js";
import { createAdapter } from "../chat/stream.js";
import type { AdapterOptions, ConversationAdapter, StreamEvent } from "../chat/stream.js";
import { createTokenProvider } from "../headless/auth.js";
import {
  ServerNotConfigured,
  authEndpoints,
  getAuthUrl,
  getServerUrl,
} from "../platform/config.js";

export interface CaipeAcpOptions {
  agentName?: string;
  noContext?: boolean;
  urlOverride?: string;
  version: string;
}

export interface CaipeAcpDependencies {
  getAuthUrl: (urlOverride?: string) => string;
  getServerUrl: (urlOverride?: string) => string;
  getValidToken: (authUrl: string) => Promise<string>;
  resolveSessionAgent: (
    serverUrl: string,
    getToken: () => Promise<string>,
    requestedName?: string,
  ) => Promise<Agent>;
  buildSystemContext: (
    cwd: string,
    noContext: boolean,
    server?: { serverUrl: string; getToken: () => Promise<string>; user?: Record<string, string> },
  ) => Promise<string>;
  createAdapter: (
    agent: Agent,
    streamEndpoint: string,
    getToken: () => Promise<string>,
    options?: AdapterOptions,
  ) => ConversationAdapter;
  randomUUID: () => string;
}

interface AcpSession {
  sessionId: string;
  cwd: string;
  agent: Agent;
  adapter: ConversationAdapter;
  serverUrl: string;
  systemContext: string;
  conversationId?: string;
  pendingInterrupt?: Record<string, unknown>;
  activeTurn?: ActiveTurn;
}

interface ActiveTurn {
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  remoteCancel?: Promise<void>;
}

interface ToolState {
  args: string;
}

const DEFAULT_DEPENDENCIES: CaipeAcpDependencies = {
  getAuthUrl,
  getServerUrl,
  getValidToken,
  resolveSessionAgent,
  buildSystemContext,
  createAdapter,
  randomUUID,
};

export class CaipeAcpAgent {
  private readonly sessions = new Map<string, AcpSession>();
  private readonly shutdown = new AbortController();
  private closing?: Promise<void>;
  private nativeResume = false;
  private nativeEvents = false;
  private readonly loading = new Set<string>();

  constructor(
    private readonly options: CaipeAcpOptions,
    private readonly dependencies: CaipeAcpDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  createApp(): acp.AgentApp {
    return acp
      .agent({ name: "caipe-cli" })
      .onRequest(acp.methods.agent.initialize, (context) => this.initialize(context.params))
      .onRequest(acp.methods.agent.session.new, (context) => this.newSession(context.params))
      .onRequest(acp.methods.agent.session.load, (context) =>
        this.loadSession(context.params, context.client),
      )
      .onRequest(acp.methods.agent.session.prompt, (context) =>
        this.prompt(context.params, context.client, context.signal),
      )
      .onNotification(acp.methods.agent.session.cancel, (context) => this.cancel(context.params));
  }

  initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    this.nativeResume = params.clientCapabilities?._meta?.caipeNativeHumanInput === 1;
    this.nativeEvents = params.clientCapabilities?._meta?.["caipe.io/native-acp"] === 1;
    const authMethods: acp.AuthMethod[] = [];
    if (params.clientCapabilities?.auth?.terminal === true) {
      authMethods.push({
        type: "terminal",
        id: "caipe-login",
        name: "Sign in to CAIPE",
        description: "Open the CAIPE browser login flow in an interactive terminal.",
        args: ["--login"],
      });
    }

    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
        sessionCapabilities: {},
      },
      authMethods,
      _meta: { caipeNativeHumanInput: 1 },
      agentInfo: {
        name: "caipe-cli",
        title: "CAIPE",
        version: this.options.version,
      },
    };
  }

  private assertOpen(): void {
    if (this.shutdown.signal.aborted)
      throw acp.RequestError.invalidRequest(undefined, "CAIPE ACP client is closing");
  }

  private validateWorkspace(params: acp.NewSessionRequest | acp.LoadSessionRequest): void {
    if (!isAbsolute(params.cwd))
      throw acp.RequestError.invalidParams(undefined, "session cwd must be an absolute path");
    if (params.additionalDirectories?.length)
      throw acp.RequestError.invalidParams(
        undefined,
        "additional workspace directories are not supported",
      );
    if (params.mcpServers.length)
      throw acp.RequestError.invalidParams(
        undefined,
        "editor-provided MCP servers cannot yet be bridged to remote CAIPE agents",
      );
  }

  private async prepareSession(cwd: string): Promise<Omit<AcpSession, "sessionId">> {
    this.assertOpen();
    const serverUrl = this.dependencies.getServerUrl(this.options.urlOverride);
    let authUrl: string;
    try {
      authUrl = this.dependencies.getAuthUrl(this.options.urlOverride);
    } catch (error) {
      if (!(error instanceof ServerNotConfigured)) throw error;
      authUrl = serverUrl;
    }
    const getToken = createTokenProvider(authUrl, () => this.dependencies.getValidToken(authUrl));
    await getToken();
    const agent = await this.dependencies.resolveSessionAgent(
      serverUrl,
      getToken,
      this.options.agentName,
    );
    const systemContext = await this.dependencies.buildSystemContext(
      cwd,
      this.options.noContext ?? false,
      { serverUrl, getToken, user: {} },
    );
    const adapter = this.dependencies.createAdapter(
      agent,
      authEndpoints(serverUrl).streamStart,
      getToken,
      { clientUser: {}, persistHistory: true },
    );
    this.assertOpen();
    return { cwd, agent, systemContext, adapter, serverUrl };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.validateWorkspace(params);
    try {
      const session = await this.prepareSession(params.cwd);
      const sessionId = await session.adapter.createConversation(this.shutdown.signal);
      this.assertOpen();
      this.sessions.set(sessionId, { ...session, sessionId, conversationId: sessionId });
      return {
        sessionId,
        _meta: { caipeConversationUrl: this.conversationUrl({ ...session, sessionId }) },
      };
    } catch (error) {
      throw asRequestError(error);
    }
  }

  async loadSession(
    params: acp.LoadSessionRequest,
    client: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    this.validateWorkspace(params);
    if (this.loading.has(params.sessionId) || this.sessions.get(params.sessionId)?.activeTurn)
      throw acp.RequestError.invalidRequest(undefined, "cannot load an active session");
    this.loading.add(params.sessionId);
    try {
      const session = await this.prepareSession(params.cwd);
      // Every load authenticates at the BFF; local session state is never proof of access.
      const loaded = await session.adapter.loadConversation(params.sessionId, this.shutdown.signal);
      this.assertOpen();
      const admitted: AcpSession = {
        ...session,
        sessionId: loaded.conversationId,
        conversationId: loaded.conversationId,
        pendingInterrupt: loaded.interrupt,
      };
      this.sessions.set(admitted.sessionId, admitted);
      for (const message of loaded.messages) {
        if ((message.role === "user" || message.role === "assistant") && message.content) {
          await notifyUpdate(client, admitted.sessionId, {
            sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            messageId: message._id ?? this.dependencies.randomUUID(),
            content: { type: "text", text: message.content },
          });
        }
      }
      if (loaded.interrupt) await this.notifyPaused(admitted, client);
      return {
        _meta: {
          caipeConversationUrl: this.conversationUrl(admitted),
          caipePendingInterrupt: loaded.interrupt,
        },
      };
    } catch (error) {
      throw asRequestError(error);
    } finally {
      this.loading.delete(params.sessionId);
    }
  }

  async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
    requestSignal: AbortSignal,
  ): Promise<acp.PromptResponse> {
    this.assertOpen();
    const session = this.sessions.get(params.sessionId);
    if (!session)
      throw acp.RequestError.invalidParams(
        undefined,
        "unknown ACP session; use session/load to restore it",
      );
    if (this.loading.has(params.sessionId) || session.activeTurn)
      throw acp.RequestError.invalidRequest(
        undefined,
        "a prompt is already running for this session",
      );
    const prompt = promptToText(params.prompt);
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const turn: ActiveTurn = { controller: new AbortController(), done, finish };
    session.activeTurn = turn;
    const cancelFromRequest = () => {
      void this.cancel({ sessionId: session.sessionId });
    };
    if (requestSignal.aborted) cancelFromRequest();
    else requestSignal.addEventListener("abort", cancelFromRequest, { once: true });
    const messageId = this.dependencies.randomUUID();
    const tools = new Map<string, ToolState>();
    const transcript = { id: messageId, content: "", events: [] as Array<Record<string, unknown>> };

    try {
      let resumeData: Record<string, unknown> | undefined;
      if (session.pendingInterrupt) {
        const supplied = params._meta?.caipeResumeData;
        if (this.nativeResume && supplied !== undefined) {
          resumeData = this.validateNativeResume(session.pendingInterrupt, supplied);
        } else {
          resumeData = await this.permissionResponse(session, client, turn.controller.signal);
          if (!resumeData) return this.pausedResponse(session, turn.controller.signal);
        }
      }
      while (!turn.controller.signal.aborted) {
        let interrupted = false;
        for await (const event of session.adapter.connect({
          prompt,
          systemContext: session.systemContext,
          sessionId: session.sessionId,
          conversationId: session.sessionId,
          agentName: session.agent.name,
          signal: turn.controller.signal,
          resumeData,
          transcript,
        })) {
          if (turn.controller.signal.aborted) return { stopReason: "cancelled" };
          if (event.type === "interrupted") {
            session.pendingInterrupt = event.interrupt ?? { reason: event.reason };
            interrupted = true;
            break;
          }
          const stopReason = await this.forwardEvent(session, event, client, messageId, tools);
          if (stopReason) {
            session.pendingInterrupt = undefined;
            return { stopReason };
          }
        }
        if (!interrupted)
          return { stopReason: turn.controller.signal.aborted ? "cancelled" : "end_turn" };
        resumeData = await this.permissionResponse(session, client, turn.controller.signal);
        if (!resumeData) return this.pausedResponse(session, turn.controller.signal);
      }
      return { stopReason: "cancelled" };
    } catch (error) {
      if (turn.controller.signal.aborted || requestSignal.aborted)
        return { stopReason: "cancelled" };
      throw asRequestError(error);
    } finally {
      requestSignal.removeEventListener("abort", cancelFromRequest);
      // Do not acknowledge cancellation or admit the next prompt before remote cleanup is requested.
      await turn.remoteCancel;
      if (session.activeTurn === turn) session.activeTurn = undefined;
      turn.finish();
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    const turn = session?.activeTurn;
    if (!session || !turn) return;
    if (!turn.remoteCancel) {
      turn.controller.abort("ACP session cancelled");
      turn.remoteCancel = session.adapter
        .cancelConversation(session.sessionId)
        .then(() => undefined)
        .catch(() => {
          process.stderr.write(
            "CAIPE remote cancellation could not be confirmed; check the conversation in CAIPE.\n",
          );
        });
    }
    await turn.remoteCancel;
  }

  /** EOF/SIGTERM closes admission immediately, then drains remote cancellation and active handlers. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.shutdown.abort("ACP connection closed");
    const active = [...this.sessions.values()].filter((session) => session.activeTurn);
    this.closing = boundedDrain(
      Promise.all(
        active.map(async (session) => {
          const turn = session.activeTurn;
          await this.cancel({ sessionId: session.sessionId });
          await turn?.done;
        }),
      ).then(() => undefined),
      6_000,
    );
    return this.closing;
  }

  private conversationUrl(session: Pick<AcpSession, "sessionId" | "serverUrl">): string {
    return `${session.serverUrl}/chat/${encodeURIComponent(session.sessionId)}`;
  }

  private pausedResponse(session: AcpSession, signal: AbortSignal): acp.PromptResponse {
    return {
      stopReason: signal.aborted ? "cancelled" : "refusal",
      _meta: {
        caipePendingInterrupt: session.pendingInterrupt,
        caipeConversationUrl: this.conversationUrl(session),
        caipeStatus: "input_required",
      },
    };
  }

  private async notifyPaused(
    session: AcpSession,
    client: acp.AgentContext,
    signal: AbortSignal = this.shutdown.signal,
  ): Promise<void> {
    if (this.nativeEvents) {
      const interrupt = session.pendingInterrupt ?? {};
      const payload = (interrupt.payload ?? {}) as Record<string, unknown>;
      await abortable(
        client.request(
          "_caipe/event",
          {
            sessionId: session.sessionId,
            event: {
              ...payload,
              kind: "input_required",
              interrupt_id: interrupt.id,
              type: interrupt.reason === "tool_approval" ? "tool_approval" : "form_input",
              interrupt,
              conversationUrl: this.conversationUrl(session),
            },
          },
          { cancellationSignal: signal },
        ),
        signal,
      );
    }
    await notifyUpdate(client, session.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `Human input is required. The agent remains paused. Continue in CAIPE: ${this.conversationUrl(session)}`,
      },
      _meta: { caipePendingInterrupt: session.pendingInterrupt },
    });
  }

  private validateNativeResume(
    interrupt: Record<string, unknown>,
    supplied: unknown,
  ): Record<string, unknown> {
    if (
      interrupt.reason !== "human_input" ||
      !supplied ||
      typeof supplied !== "object" ||
      Array.isArray(supplied)
    )
      throw acp.RequestError.invalidParams(
        undefined,
        "native form response does not match the pending input",
      );
    const response = supplied as Record<string, unknown>;
    if (response.type !== "form_input" || (!response.values && response.dismissed !== true))
      throw acp.RequestError.invalidParams(
        undefined,
        "provide form_input values or an explicit dismissal",
      );
    return response;
  }

  private async permissionResponse(
    session: AcpSession,
    client: acp.AgentContext,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const interrupt = session.pendingInterrupt;
    if (!interrupt || signal.aborted) return undefined;
    if (interrupt.reason !== "tool_approval") {
      await this.notifyPaused(session, client, signal);
      return undefined;
    }
    const payload = (interrupt.payload ?? {}) as Record<string, unknown>;
    const approvals = Array.isArray(payload.tool_approvals)
      ? (payload.tool_approvals as Array<Record<string, unknown>>)
      : [payload];
    const decisions: Array<{ decision: string }> = [];
    for (const [index, approval] of approvals.entries()) {
      const allowed = Array.isArray(approval.allowed_decisions)
        ? approval.allowed_decisions
        : ["approve", "reject"];
      const options: acp.PermissionOption[] = [];
      if (allowed.includes("approve"))
        options.push({ optionId: "approve", name: "Approve this call", kind: "allow_once" });
      if (allowed.includes("reject"))
        options.push({ optionId: "reject", name: "Reject this call", kind: "reject_once" });
      if (!options.length) {
        await this.notifyPaused(session, client, signal);
        return undefined;
      }
      try {
        const response = await abortable(
          client.request(
            acp.methods.client.session.requestPermission,
            {
              sessionId: session.sessionId,
              toolCall: {
                toolCallId: String(
                  approval.tool_call_id ?? `${interrupt.id ?? "approval"}-${index}`,
                ),
                title: String(approval.tool_name ?? "Tool approval"),
                kind: inferToolKind(String(approval.tool_name ?? "")),
                status: "pending",
                rawInput: approval.tool_args,
              },
              options,
              _meta: { caipePendingInterrupt: interrupt },
            },
            { cancellationSignal: signal },
          ),
          signal,
        );
        if (signal.aborted) return undefined;
        if (response.outcome.outcome === "cancelled") {
          await this.notifyPaused(session, client, signal);
          return undefined;
        }
        const decision = response.outcome.optionId;
        if (!options.some((option) => option.optionId === decision))
          throw acp.RequestError.invalidParams(
            undefined,
            "client selected an unknown permission option",
          );
        decisions.push({ decision });
      } catch (error) {
        if (signal.aborted) return undefined;
        if (error instanceof acp.RequestError && error.code === -32601) {
          await this.notifyPaused(session, client, signal);
          return undefined;
        }
        throw error;
      }
    }
    return decisions.length === 1
      ? { type: "tool_approval", decision: decisions[0]?.decision }
      : { type: "tool_approval", decisions };
  }

  private async forwardEvent(
    session: AcpSession,
    event: StreamEvent,
    client: acp.AgentContext,
    messageId: string,
    tools: Map<string, ToolState>,
  ): Promise<acp.StopReason | undefined> {
    switch (event.type) {
      case "conversation":
        session.conversationId = event.conversationId;
        return undefined;
      case "token":
        if (event.text.length > 0) {
          await notifyUpdate(client, session.sessionId, {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content: { type: "text", text: event.text },
          });
        }
        return undefined;
      case "tool": {
        const toolCallId = event.toolCallId ?? this.dependencies.randomUUID();
        tools.set(toolCallId, { args: "" });
        await notifyUpdate(client, session.sessionId, {
          sessionUpdate: "tool_call",
          toolCallId,
          title: humanizeToolName(event.name),
          kind: inferToolKind(event.name),
          status: "in_progress",
          rawInput: event.input,
        });
        return undefined;
      }
      case "tool-args": {
        const tool = tools.get(event.toolCallId);
        if (tool) tool.args += event.delta;
        return undefined;
      }
      case "tool-end": {
        const tool = tools.get(event.toolCallId);
        if (tool) {
          await notifyUpdate(client, session.sessionId, {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: "in_progress",
            rawInput: parseJsonOrText(tool.args),
          });
        }
        return undefined;
      }
      case "tool-result":
        await notifyUpdate(client, session.sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: event.content },
            },
          ],
          rawOutput: parseJsonOrText(event.content),
        });
        tools.delete(event.toolCallId);
        return undefined;
      case "interrupted":
        return undefined;
      case "error":
        throw acp.RequestError.internalError(
          { sessionId: session.sessionId },
          redactError(event.message),
        );
      case "done":
        return "end_turn";
      case "started":
      case "state":
        return undefined;
    }
  }
}

async function notifyUpdate(
  client: acp.AgentContext,
  sessionId: string,
  update: acp.SessionUpdate,
): Promise<void> {
  await client.notify(acp.methods.client.session.update, { sessionId, update });
}

export function promptToText(blocks: acp.ContentBlock[]): string {
  const parts = blocks.map((block) => {
    switch (block.type) {
      case "text":
        return block.text;
      case "resource_link": {
        const label = block.title?.trim() || block.name;
        const description = block.description?.trim();
        return `${description ? `${description}\n` : ""}[${label}](${block.uri})`;
      }
      default:
        throw acp.RequestError.invalidParams(
          { contentType: block.type },
          `unsupported prompt content type: ${block.type}`,
        );
    }
  });
  const text = parts
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
  if (!text) throw acp.RequestError.invalidParams(undefined, "prompt must not be empty");
  return text;
}

function asRequestError(error: unknown): acp.RequestError {
  if (error instanceof acp.RequestError) return error;
  if (error instanceof AuthRequired || hasErrorName(error, "AuthRequired")) {
    return acp.RequestError.authRequired(
      { loginCommand: "caipe auth login" },
      redactError(errorMessage(error)),
    );
  }
  if (error instanceof ServerNotConfigured || hasErrorName(error, "ServerNotConfigured")) {
    return acp.RequestError.invalidParams(undefined, errorMessage(error));
  }
  return acp.RequestError.internalError(
    undefined,
    "CAIPE request failed; check the server connection and permissions.",
  );
}

function hasErrorName(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonOrText(value: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function humanizeToolName(name: string): string {
  const readable = name.replace(/[_-]+/g, " ").trim();
  return readable ? readable.charAt(0).toUpperCase() + readable.slice(1) : "Tool call";
}

function inferToolKind(name: string): acp.ToolKind {
  const normalized = name.toLowerCase();
  if (/delete|remove/.test(normalized)) return "delete";
  if (/move|rename/.test(normalized)) return "move";
  if (/write|edit|patch|update|create/.test(normalized)) return "edit";
  if (/read|list|get|inspect|view/.test(normalized)) return "read";
  if (/search|find|query|lookup/.test(normalized)) return "search";
  if (/fetch|download|http|web/.test(normalized)) return "fetch";
  if (/think|plan|reason/.test(normalized)) return "think";
  if (/exec|shell|command|terminal|run/.test(normalized)) return "execute";
  return "other";
}

async function boundedDrain(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("ACP request cancelled");
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("ACP request cancelled"));
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function redactError(message: string): string {
  let result = message.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
  for (const name of ["CAIPE_TOKEN", "CAIPE_API_KEY", "CAIPE_CLIENT_SECRET"]) {
    const value = process.env[name];
    if (value) result = result.split(value).join("[redacted]");
  }
  return result;
}
