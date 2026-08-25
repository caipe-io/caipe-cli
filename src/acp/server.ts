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
import type { StreamAdapter, StreamEvent } from "../chat/stream.js";
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
    server?: { serverUrl: string; getToken: () => Promise<string> },
  ) => Promise<string>;
  createAdapter: (
    agent: Agent,
    streamEndpoint: string,
    getToken: () => Promise<string>,
  ) => StreamAdapter;
  randomUUID: () => string;
}

interface AcpSession {
  sessionId: string;
  cwd: string;
  agent: Agent;
  adapter: StreamAdapter;
  systemContext: string;
  conversationId?: string;
  activeTurn?: AbortController;
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

  constructor(
    private readonly options: CaipeAcpOptions,
    private readonly dependencies: CaipeAcpDependencies = DEFAULT_DEPENDENCIES,
  ) {}

  createApp(): acp.AgentApp {
    return acp
      .agent({ name: "caipe-cli" })
      .onRequest(acp.methods.agent.initialize, (context) => this.initialize(context.params))
      .onRequest(acp.methods.agent.session.new, (context) => this.newSession(context.params))
      .onRequest(acp.methods.agent.session.prompt, (context) =>
        this.prompt(context.params, context.client, context.signal),
      )
      .onNotification(acp.methods.agent.session.cancel, (context) => this.cancel(context.params));
  }

  initialize(params: acp.InitializeRequest): acp.InitializeResponse {
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
        loadSession: false,
        promptCapabilities: {},
        sessionCapabilities: {},
      },
      authMethods,
      agentInfo: {
        name: "caipe-cli",
        title: "CAIPE",
        version: this.options.version,
      },
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw acp.RequestError.invalidParams(
        { cwd: params.cwd },
        "session cwd must be an absolute path",
      );
    }
    if (params.additionalDirectories && params.additionalDirectories.length > 0) {
      throw acp.RequestError.invalidParams(
        { additionalDirectories: params.additionalDirectories },
        "additional workspace directories are not supported",
      );
    }
    if (params.mcpServers.length > 0) {
      throw acp.RequestError.invalidParams(
        { mcpServers: params.mcpServers.map((server) => server.name) },
        "editor-provided MCP servers cannot yet be bridged to remote CAIPE agents",
      );
    }

    try {
      const authUrl = this.dependencies.getAuthUrl(this.options.urlOverride);
      const serverUrl = this.dependencies.getServerUrl(this.options.urlOverride);
      const getToken = () => this.dependencies.getValidToken(authUrl);

      // Fail before allocating session state so ACP clients can trigger login.
      await getToken();
      const agent = await this.dependencies.resolveSessionAgent(
        serverUrl,
        getToken,
        this.options.agentName,
      );
      const systemContext = await this.dependencies.buildSystemContext(
        params.cwd,
        this.options.noContext ?? false,
        { serverUrl, getToken },
      );
      const sessionId = this.dependencies.randomUUID();
      const adapter = this.dependencies.createAdapter(
        agent,
        authEndpoints(serverUrl).streamStart,
        getToken,
      );

      this.sessions.set(sessionId, {
        sessionId,
        cwd: params.cwd,
        agent,
        adapter,
        systemContext,
      });
      return { sessionId };
    } catch (error) {
      throw asRequestError(error);
    }
  }

  async prompt(
    params: acp.PromptRequest,
    client: acp.AgentContext,
    requestSignal: AbortSignal,
  ): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw acp.RequestError.invalidParams({ sessionId: params.sessionId }, "unknown ACP session");
    }
    if (session.activeTurn) {
      throw acp.RequestError.invalidRequest(
        { sessionId: params.sessionId },
        "a prompt is already running for this session",
      );
    }

    const prompt = promptToText(params.prompt);
    const turn = new AbortController();
    session.activeTurn = turn;
    const cancelFromRequest = () => turn.abort(requestSignal.reason);
    if (requestSignal.aborted) cancelFromRequest();
    else requestSignal.addEventListener("abort", cancelFromRequest, { once: true });

    const messageId = this.dependencies.randomUUID();
    const tools = new Map<string, ToolState>();

    try {
      for await (const event of session.adapter.connect({
        prompt,
        systemContext: session.systemContext,
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        agentName: session.agent.name,
        signal: turn.signal,
      })) {
        if (turn.signal.aborted) return { stopReason: "cancelled" };

        const stopReason = await this.forwardEvent(session, event, client, messageId, tools);
        if (stopReason) return { stopReason };
      }
      return { stopReason: turn.signal.aborted ? "cancelled" : "end_turn" };
    } catch (error) {
      if (turn.signal.aborted || requestSignal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw asRequestError(error);
    } finally {
      requestSignal.removeEventListener("abort", cancelFromRequest);
      if (session.activeTurn === turn) session.activeTurn = undefined;
    }
  }

  cancel(params: acp.CancelNotification): void {
    this.sessions.get(params.sessionId)?.activeTurn?.abort("ACP session cancelled");
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
        if (event.reason) {
          await notifyUpdate(client, session.sessionId, {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content: { type: "text", text: `\n\n${event.reason}` },
          });
        }
        return "end_turn";
      case "error":
        throw acp.RequestError.internalError({ sessionId: session.sessionId }, event.message);
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
    return acp.RequestError.authRequired({ loginCommand: "caipe auth login" }, errorMessage(error));
  }
  if (error instanceof ServerNotConfigured || hasErrorName(error, "ServerNotConfigured")) {
    return acp.RequestError.invalidParams(undefined, errorMessage(error));
  }
  return acp.RequestError.internalError(undefined, errorMessage(error));
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
