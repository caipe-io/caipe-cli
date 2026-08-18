import { describe, expect, it } from "vitest";
import {
  filterAgents,
  pickerWindow,
  sortAgentsForPicker,
  truncateText,
} from "../src/agents/picker.js";
import type { Agent } from "../src/agents/types.js";

const sample: Agent[] = [
  {
    name: "agent-sre",
    displayName: "SRE",
    description: "SRE agent",
    endpoint: "",
    protocols: ["agui"],
    available: true,
    domain: "general",
    harnessId: "agentcore",
    harnessName: "Amazon Bedrock AgentCore",
  },
  {
    name: "agent-finops-agent",
    displayName: "FinOps",
    description: "FinOps assistant for LiteLLM spend",
    endpoint: "",
    protocols: ["agui"],
    available: true,
    domain: "general",
  },
];

describe("agent picker helpers", () => {
  it("filters by name and description", () => {
    expect(filterAgents(sample, "litellm").map((a) => a.name)).toEqual(["agent-finops-agent"]);
    expect(filterAgents(sample, "sre").map((a) => a.name)).toEqual(["agent-sre"]);
    expect(filterAgents(sample, "agentcore").map((a) => a.name)).toEqual(["agent-sre"]);
  });

  it("sorts active agent first", () => {
    const sorted = sortAgentsForPicker(sample, "agent-finops-agent");
    expect(sorted[0]?.name).toBe("agent-finops-agent");
  });

  it("computes scroll window", () => {
    expect(pickerWindow(30, 15, 10)).toEqual({ start: 10, end: 20 });
  });

  it("truncates long text", () => {
    expect(truncateText("hello world", 8)).toBe("hello w…");
  });
});
