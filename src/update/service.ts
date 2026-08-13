import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import semver from "semver";

export const UPDATE_REPOSITORY = "cnoe-io/caipe-cli";
export const LATEST_RELEASE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;

export interface ReleaseAsset {
  name: string;
  browserDownloadUrl: string;
  size: number;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  url: string;
  assets: ReleaseAsset[];
}

export interface ReleaseDownloads {
  binary: ReleaseAsset;
  checksums: ReleaseAsset;
}

export type InstallTarget =
  | { kind: "binary"; path: string }
  | { kind: "npm" }
  | { kind: "unsupported"; reason: string };

interface GitHubReleaseResponse {
  tag_name?: unknown;
  html_url?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  assets?: unknown;
}

interface GitHubAssetResponse {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

export function normalizeReleaseVersion(tag: string): string | null {
  const normalized = tag
    .trim()
    .replace(/^caipe\//, "")
    .replace(/^v/, "");
  return semver.valid(normalized);
}

export function platformAssetName(platform = process.platform, arch = process.arch): string | null {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  return os && cpu ? `caipe-${os}-${cpu}` : null;
}

export async function fetchLatestRelease(
  fetchImpl: typeof fetch = fetch,
  apiUrl = LATEST_RELEASE_API,
): Promise<ReleaseInfo> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const response = await fetchImpl(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "User-Agent": "caipe-cli-update-check",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new UpdateError(`GitHub release check failed (${response.status}).`);
  }

  const payload = (await response.json()) as GitHubReleaseResponse;
  if (payload.draft === true || payload.prerelease === true) {
    throw new UpdateError("GitHub returned a non-stable release as latest.");
  }
  if (typeof payload.tag_name !== "string" || typeof payload.html_url !== "string") {
    throw new UpdateError("GitHub returned an invalid release payload.");
  }
  const version = normalizeReleaseVersion(payload.tag_name);
  if (!version) throw new UpdateError(`Unsupported release tag: ${payload.tag_name}`);
  if (!Array.isArray(payload.assets)) {
    throw new UpdateError("GitHub release has no downloadable assets.");
  }

  const assets = payload.assets.flatMap((item): ReleaseAsset[] => {
    if (!item || typeof item !== "object") return [];
    const asset = item as GitHubAssetResponse;
    if (
      typeof asset.name !== "string" ||
      typeof asset.browser_download_url !== "string" ||
      typeof asset.size !== "number"
    ) {
      return [];
    }
    return [
      {
        name: asset.name,
        browserDownloadUrl: asset.browser_download_url,
        size: asset.size,
      },
    ];
  });

  return { version, tag: payload.tag_name, url: payload.html_url, assets };
}

export function releaseDownloads(
  release: ReleaseInfo,
  assetName = platformAssetName(),
): ReleaseDownloads {
  if (!assetName)
    throw new UpdateError(`Unsupported platform: ${process.platform}/${process.arch}`);
  const binary = release.assets.find((asset) => asset.name === assetName);
  const checksums = release.assets.find((asset) => asset.name === "caipe-checksums.txt");
  if (!binary || !checksums) {
    throw new UpdateError(
      `Release ${release.version} does not contain ${assetName} and caipe-checksums.txt.`,
    );
  }
  return { binary, checksums };
}

export function isUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  const current = semver.valid(currentVersion);
  const latest = semver.valid(latestVersion);
  if (!current || !latest) throw new UpdateError("Cannot compare invalid CLI release versions.");
  return semver.gt(latest, current);
}

export function checksumForAsset(checksums: string, assetName: string): string | null {
  for (const line of checksums.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match?.[2] === assetName) return match[1]?.toLowerCase() ?? null;
  }
  return null;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadBytes(asset: ReleaseAsset, fetchImpl: typeof fetch): Promise<Uint8Array> {
  if (asset.size <= 0 || asset.size > MAX_DOWNLOAD_BYTES) {
    throw new UpdateError(`Refusing unexpected download size for ${asset.name}: ${asset.size}.`);
  }
  const response = await fetchImpl(asset.browserDownloadUrl, {
    headers: { "User-Agent": "caipe-cli-updater" },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new UpdateError(`Download failed for ${asset.name} (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== asset.size) {
    throw new UpdateError(
      `Download size mismatch for ${asset.name}: expected ${asset.size}, received ${bytes.byteLength}.`,
    );
  }
  return bytes;
}

export async function downloadVerifiedBinary(
  release: ReleaseInfo,
  fetchImpl: typeof fetch = fetch,
  assetName = platformAssetName(),
): Promise<Uint8Array> {
  const downloads = releaseDownloads(release, assetName);
  const [binary, checksumBytes] = await Promise.all([
    downloadBytes(downloads.binary, fetchImpl),
    downloadBytes(downloads.checksums, fetchImpl),
  ]);
  const expected = checksumForAsset(new TextDecoder().decode(checksumBytes), downloads.binary.name);
  if (!expected) {
    throw new UpdateError(`No checksum published for ${downloads.binary.name}.`);
  }
  const actual = sha256(binary);
  if (actual !== expected) {
    throw new UpdateError(`Checksum verification failed for ${downloads.binary.name}.`);
  }
  return binary;
}

export function resolveInstallTarget(
  input: {
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    isBun?: boolean;
  } = {},
): InstallTarget {
  const env = input.env ?? process.env;
  const execPath = input.execPath ?? process.execPath;
  const isBun = input.isBun ?? Boolean(process.versions.bun);
  if (env.CAIPE_INSTALL_METHOD === "npm") return { kind: "npm" };
  if (env.CAIPE_BINARY_PATH) return { kind: "binary", path: env.CAIPE_BINARY_PATH };

  const executable = basename(execPath);
  if (isBun && (executable === "caipe" || /^caipe-(darwin|linux)-(arm64|x64)$/.test(executable))) {
    return { kind: "binary", path: execPath };
  }
  return {
    kind: "unsupported",
    reason: "This installation is managed from source, a local package, or an unknown launcher.",
  };
}

export type SmokeTest = (path: string, expectedVersion: string) => void;

const defaultSmokeTest: SmokeTest = (path, expectedVersion) => {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, CAIPE_NO_UPDATE_CHECK: "1" },
  });
  if (result.status !== 0 || result.stdout.trim() !== expectedVersion) {
    throw new UpdateError(`Downloaded binary failed its version check for ${expectedVersion}.`);
  }
};

export function installBinaryAtomically(
  targetPath: string,
  bytes: Uint8Array,
  expectedVersion: string,
  smokeTest: SmokeTest = defaultSmokeTest,
): void {
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.update-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    writeFileSync(tempPath, bytes, { flag: "wx", mode: 0o755 });
    chmodSync(tempPath, 0o755);
    smokeTest(tempPath, expectedVersion);
    renameSync(tempPath, targetPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw error instanceof UpdateError
      ? error
      : new UpdateError(`Could not replace ${targetPath}: ${detail}`);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export async function installReleaseBinary(
  release: ReleaseInfo,
  targetPath: string,
  fetchImpl: typeof fetch = fetch,
  smokeTest: SmokeTest = defaultSmokeTest,
): Promise<void> {
  const bytes = await downloadVerifiedBinary(release, fetchImpl);
  installBinaryAtomically(targetPath, bytes, release.version, smokeTest);
}
