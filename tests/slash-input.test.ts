import { describe, expect, it } from "vitest";
import { slashCommandQuery, slashInputHasArguments } from "../src/chat/Repl.js";

describe("slash command input", () => {
  it("filters by command name while preserving arguments for execution", () => {
    expect(slashCommandQuery("/theme high-contrast")).toBe("theme");
    expect(slashInputHasArguments("/theme high-contrast")).toBe(true);
  });

  it("distinguishes command completion from argument entry", () => {
    expect(slashCommandQuery("/sta")).toBe("sta");
    expect(slashInputHasArguments("/sta")).toBe(false);
    expect(slashInputHasArguments("/theme ")).toBe(false);
  });
});
