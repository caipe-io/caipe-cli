import { describe, expect, it } from "vitest";
import { oidcClaimsFromJwt } from "../src/auth/claims.js";
import type { TokenSet } from "../src/auth/keychain.js";
import { clientUserFromTokenSet, formatClientContextBlock } from "../src/chat/context.js";

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("oidcClaimsFromJwt", () => {
  it("reads email and sub from payload", () => {
    const jwt = fakeJwt({
      sub: "abc-123",
      email: "you@example.com",
      name: "You",
    });
    expect(oidcClaimsFromJwt(jwt)).toEqual({
      sub: "abc-123",
      email: "you@example.com",
      name: "You",
      preferredUsername: undefined,
    });
  });
});

describe("formatClientContextBlock", () => {
  it("includes user email when provided", () => {
    const block = formatClientContextBlock({
      now: new Date("2026-07-24T15:00:00.000Z"),
      user: { email: "you@cisco.com", name: "You", sub: "kc-id" },
    });
    expect(block).toContain("User email: you@cisco.com");
    expect(block).toContain("User name: You");
    expect(block).toContain("User id: kc-id");
  });

  it("derives email from token set", () => {
    const tokens: TokenSet = {
      accessToken: "x",
      email: "agent-user@grid.example.com",
      displayName: "Agent User",
      identity: "uuid-sub",
    };
    expect(clientUserFromTokenSet(tokens).email).toBe("agent-user@grid.example.com");
  });
});
