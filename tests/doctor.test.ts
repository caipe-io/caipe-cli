import { describe, expect, it } from "vitest";
import {
  type DoctorDependencies,
  collectDoctorReport,
  formatDoctorReport,
} from "../src/platform/doctor.js";

function dependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    getServerUrl: () => "https://grid.example.com",
    getAuthUrl: () => "https://idp.example.com/realms/example",
    loadTokens: async () => ({ accessToken: "token", identity: "test-user@example.com" }),
    isExpired: () => false,
    fetchAgents: async () => [{ name: "primary" }, { name: "secondary" }],
    ...overrides,
  };
}

describe("collectDoctorReport", () => {
  it("reports a healthy CLI", async () => {
    const report = await collectDoctorReport(dependencies());

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Authentication", status: "pass" }),
        expect.objectContaining({ name: "Agents", status: "pass", detail: "2 accessible agents" }),
      ]),
    );
    expect(formatDoctorReport(report)).toContain("Ready to chat.");
  });

  it("provides next commands when setup is incomplete", async () => {
    const report = await collectDoctorReport(
      dependencies({
        getServerUrl: () => {
          throw new Error("Server missing");
        },
        getAuthUrl: () => {
          throw new Error("OAuth missing");
        },
        loadTokens: async () => null,
      }),
    );

    expect(report.ok).toBe(false);
    const text = formatDoctorReport(report);
    expect(text).toContain("caipe config set server.url");
    expect(text).toContain("caipe auth login");
    expect(text).toContain("Skipped until server and authentication checks pass");
  });
});
