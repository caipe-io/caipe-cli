#!/usr/bin/env node
/**
 * npm/npx entrypoint: platform binary or Node bundle (reliable), with compile/tsx fallbacks.
 *
 * Do not copy dist/caipe into PATH directly — some environments SIGKILL Bun binaries
 * (e.g. under ~/.local/bin). Use this wrapper or `npm link` from the repo.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const preferCompiled = process.env.CAIPE_USE_COMPILED === "1";

const PLATFORM_PACKAGES = [
  { os: "darwin", cpu: "arm64", pkg: "caipe-darwin-arm64" },
  { os: "darwin", cpu: "x64", pkg: "caipe-darwin-x64" },
  { os: "linux", cpu: "arm64", pkg: "caipe-linux-arm64" },
  { os: "linux", cpu: "x64", pkg: "caipe-linux-x64" },
];

function die(msg) {
  process.stderr.write(`[caipe] ${msg}\n`);
  process.exit(1);
}

/** @typedef {{ kind: "exec", bin: string, binArgs: string[], env?: Record<string, string> } | { kind: "node", script: string, extraArgs?: string[], env?: Record<string, string> }} LaunchSpec */

/** @returns {LaunchSpec[]} */
function launchChain() {
  /** @type {LaunchSpec[]} */
  const chain = [];
  /** @type {LaunchSpec | null} */
  let packagedBinary = null;

  const os = process.platform;
  const cpu = process.arch;
  for (const entry of PLATFORM_PACKAGES) {
    if (entry.os !== os || entry.cpu !== cpu) continue;
    let binPath;
    try {
      binPath = require.resolve(path.join(entry.pkg, "bin/caipe"));
    } catch {
      continue;
    }
    if (fs.existsSync(binPath)) {
      const packageParent = path.dirname(root);
      const npmManaged =
        path.basename(packageParent) === "node_modules" &&
        path.basename(path.dirname(packageParent)) === "lib";
      packagedBinary = {
        kind: "exec",
        bin: binPath,
        binArgs: args,
        env: npmManaged
          ? { CAIPE_INSTALL_METHOD: "npm" }
          : { CAIPE_INSTALL_METHOD: "binary", CAIPE_BINARY_PATH: binPath },
      };
      chain.push(packagedBinary);
      break;
    }
  }

  const bundleCjs = path.join(root, "dist", "bundle.cjs");
  if (fs.existsSync(bundleCjs)) {
    chain.push({
      kind: "node",
      script: bundleCjs,
      extraArgs: args,
      env: { CAIPE_INSTALL_METHOD: "source" },
    });
  }

  let tsxCli;
  try {
    tsxCli = require.resolve("tsx/cli");
  } catch {
    tsxCli = null;
  }
  const entry = path.join(root, "src", "index.ts");
  if (tsxCli && fs.existsSync(entry)) {
    chain.unshift({
      kind: "node",
      script: tsxCli,
      extraArgs: [entry, ...args],
      env: { CAIPE_INSTALL_METHOD: "source" },
    });
  }

  const local = path.join(root, "dist", "caipe");
  if (fs.existsSync(local)) {
    chain.push({
      kind: "exec",
      bin: local,
      binArgs: args,
      env: { CAIPE_INSTALL_METHOD: "binary", CAIPE_BINARY_PATH: local },
    });
  }

  if (preferCompiled && chain.length > 1) {
    const compiled = chain.find((s) => s.kind === "exec");
    const rest = chain.filter((s) => s !== compiled);
    return compiled ? [compiled, ...rest] : chain;
  }

  // Registry installs should use the matching multi-arch package first. If
  // that binary cannot run, runChain will fall back to the Node-based paths.
  if (packagedBinary) {
    return [packagedBinary, ...chain.filter((spec) => spec !== packagedBinary)];
  }

  // Default: tsx/node first, then compiled binary (Bun compile can be SIGKILL'd in some PATH layouts).
  const execs = chain.filter((s) => s.kind === "exec");
  const nodes = chain.filter((s) => s.kind === "node");
  return [...nodes, ...execs];
}

function spawnSpec(spec) {
  const env = spec.env ? { ...process.env, ...spec.env } : process.env;
  if (spec.kind === "exec") {
    return spawnSync(spec.bin, spec.binArgs, { stdio: "inherit", env });
  }
  const nodeArgs = [spec.script];
  if (spec.extraArgs?.length) nodeArgs.push(...spec.extraArgs);
  return spawnSync(process.execPath, nodeArgs, { stdio: "inherit", env });
}

function wasSigKill(result) {
  return result.signal === "SIGKILL" || result.status === 137;
}

function runChain(chain) {
  for (let i = 0; i < chain.length; i++) {
    const r = spawnSpec(chain[i]);
    if (r.error) {
      die(r.error.message);
    }
    if (wasSigKill(r) && i + 1 < chain.length) {
      process.stderr.write(
        "[caipe] Compiled binary was killed (signal 9); retrying with Node…\n",
      );
      continue;
    }
    process.exit(r.status ?? (r.signal ? 128 : 1));
  }
  die(
    "Could not start caipe. Install the published package with `npm install -g @caipe-io/caipe`, use install.sh, or run `npm run dev -- --version` from a checkout.",
  );
}

runChain(launchChain());
