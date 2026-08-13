import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAgents, pickSessionAgent } from "../src/agents/registry.js";
import type { Agent } from "../src/agents/types.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `caipe-agents-${process.pid}-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  process.env.XDG_CONFIG_HOME = testDir;
});

afterEach(() => {
  process.env.XDG_CONFIG_HOME = "";
  vi.unstubAllGlobals();
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

const agents: Agent[] = [
  {
    name: "agent-alpha",
    displayName: "Alpha",
    description: "",
    endpoint: "",
    protocols: ["agui"],
    available: true,
    domain: "general",
  },
  {
    name: "agent-sre",
    displayName: "SRE",
    description: "",
    endpoint: "",
    protocols: ["agui"],
    available: true,
    domain: "general",
  },
];

describe("pickSessionAgent", () => {
  it("uses explicit agent when requested", () => {
    expect(pickSessionAgent(agents, "agent-sre").name).toBe("agent-sre");
  });

  it("uses configured default before first in list", () => {
    expect(pickSessionAgent(agents, "default", "agent-sre").name).toBe("agent-sre");
    expect(pickSessionAgent(agents, undefined, "agent-sre").name).toBe("agent-sre");
  });

  it("falls back to first available when no default configured", () => {
    expect(pickSessionAgent(agents).name).toBe("agent-alpha");
  });

  it("falls back when configured default is not in list", () => {
    expect(pickSessionAgent(agents, "default", "missing-agent").name).toBe("agent-alpha");
  });
});

describe("fetchAgents", () => {
  it("fetches every page of accessible agents", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            agents: [
              { id: "agent-alpha", name: "Alpha", description: "First page" },
              { id: "agent-beta", name: "Beta", description: "First page" },
            ],
            total: 3,
            page: 1,
            page_size: 2,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            agents: [{ id: "agent-tome", name: "Tome Agent", description: "Second page" }],
            total: 3,
            page: 2,
            page_size: 2,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAgents("https://grid.example.com", async () => "token");

    expect(result.map((agent) => agent.name)).toEqual(["agent-alpha", "agent-beta", "agent-tome"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://grid.example.com/api/user/accessible-agents?page=1&page_size=100",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "https://grid.example.com/api/user/accessible-agents?page=2&page_size=100",
    );
  });

  it("does not reuse an agent cache from another server", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            agents: [{ id: "agent-alpha", name: "Alpha", description: "" }],
            total: 1,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            agents: [{ id: "agent-beta", name: "Beta", description: "" }],
            total: 1,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchAgents("https://primary.example.com", async () => "token");
    const second = await fetchAgents("https://secondary.example.com", async () => "token");

    expect(first.map((agent) => agent.name)).toEqual(["agent-alpha"]);
    expect(second.map((agent) => agent.name)).toEqual(["agent-beta"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a fresh agent cache for the same server", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: {
          agents: [{ id: "agent-alpha", name: "Alpha", description: "" }],
          total: 1,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchAgents("https://grid.example.com", async () => "token");
    const cached = await fetchAgents("https://grid.example.com", async () => "token");

    expect(cached.map((agent) => agent.name)).toEqual(["agent-alpha"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails when pagination stops making progress", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: {
            agents: [{ id: "agent-alpha", name: "Alpha", description: "" }],
            total: 2,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: { agents: [], total: 2 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAgents("https://grid.example.com", async () => "token")).rejects.toThrow(
      "pagination stopped after 1 of 2 agents",
    );
  });
});
