import type { Agent } from "../agents/types.js";

export interface SessionStatusInfo {
  agent: Agent;
  serverUrl?: string;
  workingDir: string;
  sessionId: string;
  conversationId?: string;
  messageCount: number;
  approxTokens: number;
}

function displayServer(serverUrl?: string): string {
  if (!serverUrl) return "(not configured)";
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

/** Stable, plain-text session summary for `/status`. */
export function formatSessionStatus(info: SessionStatusInfo): string {
  const agent =
    info.agent.displayName === info.agent.name
      ? info.agent.name
      : `${info.agent.displayName} (${info.agent.name})`;
  const row = (label: string, value: string): string => `  ${label.padEnd(13)}${value}`;
  return [
    "Session status",
    row("agent", agent),
    row("server", displayServer(info.serverUrl)),
    row("workspace", info.workingDir),
    row("session", info.sessionId.slice(0, 8)),
    row("conversation", info.conversationId ? "linked" : "local only"),
    row("context", `${info.messageCount} messages · ~${info.approxTokens} tokens`),
  ].join("\n");
}
