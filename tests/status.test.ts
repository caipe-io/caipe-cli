import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT } from "../src/agents/types.js";
import { formatSessionStatus } from "../src/chat/status.js";

describe("formatSessionStatus", () => {
  it("shows the active execution context", () => {
    const text = formatSessionStatus({
      agent: { ...DEFAULT_AGENT, name: "primary", displayName: "Primary Agent" },
      serverUrl: "https://grid.example.com/path",
      workingDir: "/workspace/example",
      sessionId: "12345678-abcd",
      conversationId: "conversation-1",
      messageCount: 4,
      approxTokens: 120,
    });

    expect(text).toContain("Primary Agent (primary)");
    expect(text).toContain("grid.example.com");
    expect(text).toContain("/workspace/example");
    expect(text).toContain("12345678");
    expect(text).toContain("linked");
    expect(text).toContain("4 messages · ~120 tokens");
  });
});
