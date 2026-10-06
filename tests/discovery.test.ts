import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  discoverAgentConfig,
  heuristicAuthIssuerCandidates,
  oauthIssuerFromConfig,
} from "../src/platform/discovery.js";

describe("discovery cache isolation", () => {
  it("never supplies one connection's OAuth endpoint to another deployment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caipe-issuer-cache-"));
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          oauth: {
            token_endpoint: "https://idp-first.example.test/token",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ oauth: { token_endpoint: "https://idp-second.example.test/token" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect((await discoverAgentConfig("https://first.example.test")).oauth?.token_endpoint).toBe(
        "https://idp-first.example.test/token",
      );
      expect((await discoverAgentConfig("https://second.example.test")).oauth?.token_endpoint).toBe(
        "https://idp-second.example.test/token",
      );
      expect((await discoverAgentConfig("https://second.example.test")).oauth?.token_endpoint).toBe(
        "https://idp-second.example.test/token",
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("oauthIssuerFromConfig", () => {
  it("returns explicit issuer when present", () => {
    expect(
      oauthIssuerFromConfig({
        oauth: {
          issuer: "https://idp.example.com/realms/caipe/",
          token_endpoint: "https://other.example.com/token",
        },
      }),
    ).toBe("https://idp.example.com/realms/caipe");
  });

  it("derives issuer from Keycloak token endpoint", () => {
    expect(
      oauthIssuerFromConfig({
        oauth: {
          token_endpoint: "https://idp.example.com/realms/caipe/protocol/openid-connect/token",
          authorization_endpoint:
            "https://idp.example.com/realms/caipe/protocol/openid-connect/auth",
        },
      }),
    ).toBe("https://idp.example.com/realms/caipe");
  });

  it("returns undefined when oauth block is missing", () => {
    expect(oauthIssuerFromConfig({})).toBeUndefined();
  });
});

describe("heuristicAuthIssuerCandidates", () => {
  it("maps grid.example.com to idp.grid.example.com realm", () => {
    expect(heuristicAuthIssuerCandidates("https://grid.example.com")).toEqual([
      "https://idp.grid.example.com/realms/caipe",
      "https://grid.example.com/realms/caipe",
    ]);
  });

  it("maps grid.preview host and respects CAIPE_AUTH_REALM", () => {
    process.env.CAIPE_AUTH_REALM = "myrealm";
    expect(heuristicAuthIssuerCandidates("https://grid.preview.example.com/")).toContain(
      "https://idp.grid.preview.example.com/realms/myrealm",
    );
    delete process.env.CAIPE_AUTH_REALM;
  });

  it("returns empty for invalid URL", () => {
    expect(heuristicAuthIssuerCandidates("not-a-url")).toEqual([]);
  });
});
