/**
 * Session file persistence (conversation id + resume fields).
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  filterSessions,
  loadSession,
  patchSessionConversationId,
  resolveSessionIdByArg,
  saveSession,
} from "../src/chat/history";

const TEST_HOME = join(process.cwd(), ".test-sessions-home");

vi.mock("../src/platform/config.js", () => ({
  sessionsDir: () => join(TEST_HOME, "sessions"),
}));

describe("session persistence", () => {
  afterEach(() => {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("round-trips conversationId on save/load", () => {
    const session = createSession({
      agentName: "default",
      workingDir: "/tmp",
      conversationId: "server-conv-abc",
    });
    session.messages.push({
      role: "user",
      content: "hi",
      timestamp: new Date().toISOString(),
      agentName: "default",
      tokenCount: null,
    });
    saveSession(session);
    const loaded = loadSession(session.sessionId);
    expect(loaded?.conversationId).toBe("server-conv-abc");
    expect(loaded?.messages).toHaveLength(1);
  });

  it("patchSessionConversationId updates existing file", () => {
    const session = createSession({ agentName: "default", workingDir: "/tmp" });
    saveSession(session);
    patchSessionConversationId(session.sessionId, "new-id");
    const loaded = loadSession(session.sessionId);
    expect(loaded?.conversationId).toBe("new-id");
  });

  it("resolveSessionIdByArg matches full id and unique prefix", () => {
    const a = createSession({ agentName: "a", workingDir: "/tmp" });
    const b = createSession({ agentName: "b", workingDir: "/tmp" });
    saveSession(a);
    saveSession(b);

    expect(resolveSessionIdByArg(a.sessionId)).toEqual({ ok: true, sessionId: a.sessionId });
    expect(resolveSessionIdByArg(a.sessionId.slice(0, 8))).toEqual({
      ok: true,
      sessionId: a.sessionId,
    });
    expect(resolveSessionIdByArg("not-a-real-id").ok).toBe(false);
  });

  it("filterSessions matches id or agent name", () => {
    const sessions = [
      {
        sessionId: "abc-111",
        agentName: "agent-sre",
        protocol: "agui" as const,
        startedAt: "2026-01-01T00:00:00.000Z",
        messageCount: 1,
      },
      {
        sessionId: "def-222",
        agentName: "agent-other",
        protocol: "agui" as const,
        startedAt: "2026-01-02T00:00:00.000Z",
        messageCount: 2,
      },
    ];
    expect(filterSessions(sessions, "sre")).toHaveLength(1);
    expect(filterSessions(sessions, "def")).toHaveLength(1);
    expect(filterSessions(sessions, "")).toHaveLength(2);
  });
});
