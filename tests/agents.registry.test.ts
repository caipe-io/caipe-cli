import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("does not reuse the catalog for another connection credential", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: { agents: [{ id: "agent-private", name: "Private", description: "" }], total: 1 },
        }),
      )
      .mockResolvedValueOnce(Response.json({ success: true, data: { agents: [], total: 0 } }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchAgents("https://grid.example.com", async () => "first-account");
    expect(await fetchAgents("https://grid.example.com", async () => "another-account")).toEqual(
      [],
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(testDir, "caipe/agents-cache.json"), "utf8")).not.toContain(
      "another-account",
    );
  });

  it("refreshes new agents and fails closed instead of returning a stale sync snapshot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: { agents: [{ id: "agent-alpha", name: "Alpha", description: "" }], total: 1 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: { agents: [{ id: "agent-new", name: "New", description: "" }], total: 1 },
        }),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchAgents("https://grid.example.com", async () => "token");
    const fresh = await fetchAgents("https://grid.example.com", async () => "token", {
      fresh: true,
    });
    expect(fresh.map((agent) => agent.name)).toEqual(["agent-new"]);
    await expect(
      fetchAgents("https://grid.example.com", async () => "token", { fresh: true }),
    ).rejects.toThrow("HTTP 503");
  });

  it.each([401, 403])("does not use an expired cache after HTTP %s", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            success: true,
            data: { agents: [{ id: "agent-private", name: "Private", description: "" }], total: 1 },
          }),
        )
        .mockResolvedValueOnce(new Response("denied", { status })),
    );
    await fetchAgents("https://grid.example.com", async () => "token");
    const path = join(testDir, "caipe/agents-cache.json");
    const cache = JSON.parse(readFileSync(path, "utf8"));
    cache.cachedAt = "2020-01-01T00:00:00Z";
    writeFileSync(path, JSON.stringify(cache));
    await expect(fetchAgents("https://grid.example.com", async () => "token")).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(existsSync(path)).toBe(false);
  });

  it("does not retain a still-fresh cache after an explicit denied refresh", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          data: { agents: [{ id: "agent-private", name: "Private" }], total: 1 },
        }),
      )
      .mockResolvedValue(new Response("denied", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchAgents("https://grid.example.com", async () => "token");
    await expect(
      fetchAgents("https://grid.example.com", async () => "token", { fresh: true }),
    ).rejects.toThrow("HTTP 403");
    await expect(fetchAgents("https://grid.example.com", async () => "token")).rejects.toThrow(
      "HTTP 403",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([null, "", " agent-private "])("rejects malformed native agent ID %s", async (id) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ success: true, data: { agents: [{ id, name: "Private" }], total: 1 } }),
        ),
    );
    await expect(
      fetchAgents("https://grid.example.com", async () => "token", { fresh: true }),
    ).rejects.toThrow("invalid agent reference");
  });

  it("rejects repeated IDs instead of claiming a complete reconciliation snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        Response.json({
          success: true,
          data: { agents: [{ id: "agent-private", name: "Private" }], total: 2 },
        }),
      ),
    );
    await expect(
      fetchAgents("https://grid.example.com", async () => "token", { fresh: true }),
    ).rejects.toThrow("repeated an agent");
    expect(existsSync(join(testDir, "caipe/agents-cache.json"))).toBe(false);
  });

  it("does not claim a complete fresh catalog when pagination metadata is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          success: true,
          data: { agents: [{ id: "agent-private", name: "Private" }] },
        }),
      ),
    );
    await expect(
      fetchAgents("https://grid.example.com", async () => "token", { fresh: true }),
    ).rejects.toThrow("complete paginated registry snapshot");
  });

  it("rejects a failed registry response instead of treating it as an empty catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ success: false, error: "denied" })),
    );
    await expect(
      fetchAgents("https://grid.example.com", async () => "token", { fresh: true }),
    ).rejects.toThrow("invalid catalog response");
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
