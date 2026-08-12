import { describe, expect, it } from "vitest";
import { heuristicAuthIssuerCandidates, oauthIssuerFromConfig } from "../src/platform/discovery.js";

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
