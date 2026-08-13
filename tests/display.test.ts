import { describe, expect, it } from "vitest";
import { formatSessionBanner } from "../src/platform/display.js";

describe("formatSessionBanner", () => {
  it("shows agent, workspace, server, and shortcuts without the oversized logo", () => {
    const text = formatSessionBanner({
      agentName: "primary",
      agentDisplayName: "Primary Agent",
      serverUrl: "https://grid.example.com/api",
      workingDir: "/workspace/example",
      resumed: true,
    });

    expect(text).toContain("CAIPE");
    expect(text).toContain("resumed");
    expect(text).toContain("Primary Agent (primary)");
    expect(text).toContain("grid.example.com");
    expect(text).toContain("/ commands · Ctrl+O agents");
    expect(text).not.toContain("██████");
  });
});
