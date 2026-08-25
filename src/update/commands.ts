import { spawnSync } from "node:child_process";
import semver from "semver";
import {
  type ReleaseInfo,
  UpdateError,
  fetchLatestRelease,
  installReleaseBinary,
  isUpdateAvailable,
  releaseDownloads,
  resolveInstallTarget,
} from "./service.js";

export interface UpdateCommandOptions {
  check?: boolean;
  force?: boolean;
  json?: boolean;
}

interface UpdateResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  installed: boolean;
  releaseUrl: string;
  installMethod?: "binary" | "npm";
}

function writeResult(result: UpdateResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.installed) {
    process.stdout.write(`Updated caipe ${result.currentVersion} → ${result.latestVersion}.\n`);
  } else if (result.updateAvailable) {
    process.stdout.write(
      `Update available: ${result.currentVersion} → ${result.latestVersion}\n${result.releaseUrl}\n`,
    );
  } else {
    process.stdout.write(`caipe ${result.currentVersion} is up to date.\n`);
  }
}

function updateWithNpm(release: ReleaseInfo): void {
  const packageSpec = `@caipe-io/caipe@${release.version}`;
  const result = spawnSync("npm", ["install", "--global", packageSpec], {
    stdio: "inherit",
    env: { ...process.env, CAIPE_NO_UPDATE_CHECK: "1" },
  });
  if (result.error) throw new UpdateError(`Could not run npm: ${result.error.message}`);
  if (result.status !== 0) {
    throw new UpdateError(
      `npm could not install ${packageSpec}. Fix the npm error above and retry.`,
    );
  }
}

export async function runUpdate(
  options: UpdateCommandOptions,
  currentVersion: string,
): Promise<void> {
  try {
    const release = await fetchLatestRelease();
    releaseDownloads(release);
    const available = isUpdateAvailable(currentVersion, release.version);
    const base: UpdateResult = {
      currentVersion,
      latestVersion: release.version,
      updateAvailable: available,
      installed: false,
      releaseUrl: release.url,
    };
    const reinstallCurrent = options.force === true && semver.eq(currentVersion, release.version);
    if (options.check || (!available && !reinstallCurrent)) {
      writeResult(base, options.json === true);
      return;
    }

    const target = resolveInstallTarget();
    if (target.kind === "unsupported") {
      throw new UpdateError(
        `${target.reason} Re-run setup-caipe-cli.sh to update this installation.`,
      );
    }
    if (target.kind === "npm") {
      updateWithNpm(release);
    } else {
      await installReleaseBinary(release, target.path);
    }
    writeResult({ ...base, installed: true, installMethod: target.kind }, options.json === true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ error: detail, currentVersion })}\n`);
    } else {
      process.stderr.write(`[ERROR] ${detail}\n`);
    }
    process.exitCode = 3;
  }
}
