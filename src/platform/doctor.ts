import pkg from "../../package.json";
import { fetchAgents } from "../agents/registry.js";
import { loadTokens } from "../auth/keychain.js";
import type { TokenSet } from "../auth/keychain.js";
import { isExpired } from "../auth/tokens.js";
import { getAuthUrl, getServerUrl } from "./config.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  checks: DoctorCheck[];
}

export interface DoctorDependencies {
  getServerUrl: () => string;
  getAuthUrl: () => string;
  loadTokens: () => Promise<TokenSet | null>;
  isExpired: (tokens: TokenSet) => boolean;
  fetchAgents: (serverUrl: string, getToken: () => Promise<string>) => Promise<unknown[]>;
}

const defaultDependencies: DoctorDependencies = {
  getServerUrl,
  getAuthUrl,
  loadTokens,
  isExpired,
  fetchAgents,
};

function configuredUrl(
  name: string,
  resolve: () => string,
  fix: string,
): { value?: string; check: DoctorCheck } {
  try {
    const value = resolve();
    return { value, check: { name, status: "pass", detail: value } };
  } catch (error) {
    return {
      check: {
        name,
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        fix,
      },
    };
  }
}

export async function collectDoctorReport(
  dependencies: DoctorDependencies = defaultDependencies,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    {
      name: "Runtime",
      status: "pass",
      detail: `CAIPE ${pkg.version} · Node ${process.versions.node} · ${process.platform}/${process.arch}`,
    },
  ];

  const server = configuredUrl(
    "Server",
    dependencies.getServerUrl,
    "caipe config set server.url https://bff.example.com",
  );
  const auth = configuredUrl(
    "OAuth",
    dependencies.getAuthUrl,
    "caipe config set auth.url https://idp.example.com/realms/example",
  );
  checks.push(server.check, auth.check);

  const tokens = await dependencies.loadTokens();
  if (!tokens) {
    checks.push({
      name: "Authentication",
      status: "fail",
      detail: "No stored session",
      fix: "caipe auth login",
    });
  } else if (dependencies.isExpired(tokens)) {
    checks.push({
      name: "Authentication",
      status: "fail",
      detail: `Session expired${tokens.identity ? ` for ${tokens.identity}` : ""}`,
      fix: "caipe auth login --force",
    });
  } else {
    checks.push({
      name: "Authentication",
      status: "pass",
      detail: tokens.displayName || tokens.email || tokens.identity || "Authenticated",
    });
  }

  if (server.value && tokens && !dependencies.isExpired(tokens)) {
    try {
      const agents = await dependencies.fetchAgents(server.value, async () => tokens.accessToken);
      checks.push({
        name: "Agents",
        status: "pass",
        detail: `${agents.length} accessible agent${agents.length === 1 ? "" : "s"}`,
      });
    } catch (error) {
      checks.push({
        name: "Agents",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        fix: "Check network access and run `caipe auth login --force`",
      });
    }
  } else {
    checks.push({
      name: "Agents",
      status: "warn",
      detail: "Skipped until server and authentication checks pass",
    });
  }

  return { ok: !checks.some((check) => check.status === "fail"), version: pkg.version, checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<DoctorStatus, string> = { pass: "✓", warn: "!", fail: "✗" };
  const lines = [`CAIPE doctor ${report.version}`, ""];
  for (const check of report.checks) {
    lines.push(`${icon[check.status]} ${check.name.padEnd(16)} ${check.detail}`);
    if (check.fix) lines.push(`  Fix: ${check.fix}`);
  }
  lines.push(
    "",
    report.ok ? "Ready to chat." : "Resolve the failed checks, then run `caipe doctor` again.",
  );
  return `${lines.join("\n")}\n`;
}

export async function runDoctor(options: { json?: boolean } = {}): Promise<boolean> {
  const report = await collectDoctorReport();
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report),
  );
  return report.ok;
}
