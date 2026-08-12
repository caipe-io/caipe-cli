import { describe, expect, it } from "vitest";
import { chunkContentApiPath } from "../src/kb/client.js";

describe("chunkContentApiPath", () => {
  it("builds path for simple chunk ids", () => {
    expect(chunkContentApiPath("abc123")).toBe("/v1/chunk/abc123/content");
  });

  it("preserves slashes for path-style chunk ids", () => {
    expect(chunkContentApiPath("tenant/ds/doc/0")).toBe("/v1/chunk/tenant/ds/doc/0/content");
  });

  it("strips leading and trailing slashes on the id", () => {
    expect(chunkContentApiPath("/foo/bar/")).toBe("/v1/chunk/foo/bar/content");
  });
});
