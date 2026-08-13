import { describe, expect, it } from "vitest";
import { formatAgentListPlain } from "../src/agents/commands.js";
import type { Agent } from "../src/agents/types.js";

describe("formatAgentListPlain", () => {
  it("puts readable display names before internal ids without fixed-width overflow", () => {
    const agents: Agent[] = [
      {
        name: "agent-primary-with-a-long-internal-id",
        displayName: "Primary Agent",
        description: "Example",
        endpoint: "",
        protocols: ["agui"],
        available: true,
        domain: "general",
      },
    ];

    const output = formatAgentListPlain(agents);
    expect(output).toContain("Accessible agents (1)");
    expect(output).toContain("✓ Primary Agent");
    expect(output).toContain("  agent-primary-with-a-long-internal-id · general · agui");
  });
});
