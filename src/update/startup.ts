import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type UpdateMode, getUpdateMode, globalConfigDir } from "../platform/config.js";
import {
  fetchLatestRelease,
  installReleaseBinary,
  isUpdateAvailable,
  releaseDownloads,
  resolveInstallTarget,
} from "./service.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

interface UpdateState {
  lastCheckedAt?: string;
  lastNotifiedVersion?: string;
}

export function updateStatePath(): string {
  return join(globalConfigDir(), "update-state.json");
}

function readUpdateState(): UpdateState {
  const path = updateStatePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

function writeUpdateState(state: UpdateState): void {
  const path = updateStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function updateCheckIsDue(state: UpdateState, now = Date.now()): boolean {
  if (!state.lastCheckedAt) return true;
  const checkedAt = Date.parse(state.lastCheckedAt);
  return !Number.isFinite(checkedAt) || now - checkedAt >= CHECK_INTERVAL_MS;
}

function startupCheckEnabled(mode: UpdateMode): boolean {
  return (
    mode !== "off" &&
    process.env.CAIPE_NO_UPDATE_CHECK !== "1" &&
    process.env.CI !== "true" &&
    process.stderr.isTTY === true
  );
}

export async function maybeRunStartupUpdate(currentVersion: string): Promise<void> {
  const mode = getUpdateMode();
  if (!startupCheckEnabled(mode)) return;
  const state = readUpdateState();
  if (!updateCheckIsDue(state)) return;

  const nextState: UpdateState = { ...state, lastCheckedAt: new Date().toISOString() };
  writeUpdateState(nextState);
  try {
    const release = await fetchLatestRelease();
    releaseDownloads(release);
    if (!isUpdateAvailable(currentVersion, release.version)) return;

    if (mode === "auto") {
      const target = resolveInstallTarget();
      if (target.kind === "binary") {
        await installReleaseBinary(release, target.path);
        process.stderr.write(
          `\n[caipe] Updated to ${release.version}; the new version will run next time.\n`,
        );
        return;
      }
    }

    if (state.lastNotifiedVersion !== release.version) {
      process.stderr.write(
        `\n[caipe] Update available: ${currentVersion} → ${release.version}. Run \`caipe update\`.\n`,
      );
      writeUpdateState({ ...nextState, lastNotifiedVersion: release.version });
    }
  } catch {
    // Startup update checks are best-effort and must never block normal CLI use.
  }
}
