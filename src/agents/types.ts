/**
 * Shared Agent entity type — matches data-model.md Agent entity.
 */

export interface Agent {
  name: string;
  displayName: string;
  description: string;
  endpoint: string;
  protocols: "agui"[];
  available: boolean;
  domain: string;
  /** Execution runtime selected by the agent blueprint. Absent on older CAIPE servers. */
  harnessId?: string;
  /** Human-readable runtime name supplied by the server. */
  harnessName?: string;
}

export function normalizeHarnessId(value?: string): string {
  const normalized = value?.trim().toLowerCase();
  if (
    !normalized ||
    normalized === "dynamic_agents" ||
    normalized === "langchain-deepagents" ||
    normalized === "langchain_deepagents"
  ) {
    return "dynamic_agents";
  }
  return normalized;
}

export function harnessDisplayName(agent: Pick<Agent, "harnessId" | "harnessName">): string {
  const explicit = agent.harnessName?.trim();
  if (explicit) return explicit;
  switch (normalizeHarnessId(agent.harnessId)) {
    case "dynamic_agents":
      return "LangChain Deep Agents";
    case "agentcore":
      return "Amazon Bedrock AgentCore";
    case "claude_agent_sdk":
      return "Claude Agent SDK";
    default:
      return normalizeHarnessId(agent.harnessId);
  }
}

export const DEFAULT_AGENT: Agent = {
  name: "hello-world",
  displayName: "Hello World",
  description: "Default starter agent",
  endpoint: "",
  protocols: ["agui"],
  available: true,
  domain: "general",
  harnessId: "dynamic_agents",
  harnessName: "LangChain Deep Agents",
};
