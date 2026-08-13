#!/usr/bin/env sh
# install.sh — CAIPE CLI installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/cnoe-io/caipe-cli/main/install.sh | sh
#
# Options (environment variables):
#   CAIPE_INSTALL_DIR   — override install directory (default: /usr/local/bin)
#   CAIPE_VERSION       — pin a specific version (default: latest)
#   CAIPE_NO_VERIFY     — set to 1 to skip checksum verification (not recommended)
#
# Supports: Linux and macOS on arm64 and x64.

set -e

REPO="cnoe-io/caipe-cli"
INSTALL_DIR="${CAIPE_INSTALL_DIR:-/usr/local/bin}"
VERSION="${CAIPE_VERSION:-}"
TAG=""
NO_VERIFY="${CAIPE_NO_VERIFY:-0}"

# ── helpers ───────────────────────────────────────────────────────────────────

die() { printf '\033[31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m  >\033[0m %s\n' "$*"; }
ok() { printf '\033[32m  ✓\033[0m %s\n' "$*"; }

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    die "Required command not found: $1"
  fi
}

# ── detect platform ───────────────────────────────────────────────────────────

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin) OS_NAME="darwin" ;;
    Linux)  OS_NAME="linux" ;;
    *)      die "Unsupported OS: $OS. Only macOS and Linux are supported." ;;
  esac

  case "$ARCH" in
    arm64|aarch64) ARCH_NAME="arm64" ;;
    x86_64|amd64)  ARCH_NAME="x64" ;;
    *)             die "Unsupported architecture: $ARCH. Only arm64 and x64 are supported." ;;
  esac

  PLATFORM="${OS_NAME}-${ARCH_NAME}"
}

# ── resolve latest version ────────────────────────────────────────────────────

resolve_version() {
  if [ -n "$VERSION" ]; then
    TAG="$VERSION"
    info "Using pinned version: $VERSION"
    return
  fi

  info "Resolving latest release…"
  need_cmd curl

  TAG=$(curl -fsSL \
    "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | head -1 \
    | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

  if [ -z "$TAG" ]; then
    die "Could not determine latest caipe release. Set CAIPE_VERSION to install a specific version."
  fi

  VERSION="${TAG#caipe/}"
  VERSION="${VERSION#v}"
  info "Latest version: $VERSION"
}

# ── download and verify ───────────────────────────────────────────────────────

download_binary() {
  BINARY_NAME="caipe-${PLATFORM}"
  BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"
  BINARY_URL="${BASE_URL}/${BINARY_NAME}"
  CHECKSUMS_URL="${BASE_URL}/caipe-checksums.txt"

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  info "Downloading caipe ${VERSION} for ${PLATFORM}…"
  need_cmd curl

  curl -fsSL -o "${TMP_DIR}/${BINARY_NAME}" "${BINARY_URL}" \
    || die "Download failed. Check that version ${VERSION} exists for ${PLATFORM}."

  if [ "$NO_VERIFY" != "1" ]; then
    info "Verifying checksum…"
    curl -fsSL -o "${TMP_DIR}/checksums.txt" "${CHECKSUMS_URL}" \
      || die "Could not fetch checksums. Use CAIPE_NO_VERIFY=1 to skip (not recommended)."

    # Extract the expected hash for this binary
    EXPECTED=$(grep "${BINARY_NAME}" "${TMP_DIR}/checksums.txt" | awk '{print $1}')
    if [ -z "$EXPECTED" ]; then
      die "No checksum found for ${BINARY_NAME} in checksums.txt."
    fi

    # Compute actual hash
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL=$(sha256sum "${TMP_DIR}/${BINARY_NAME}" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      ACTUAL=$(shasum -a 256 "${TMP_DIR}/${BINARY_NAME}" | awk '{print $1}')
    else
      die "sha256sum or shasum not found. Use CAIPE_NO_VERIFY=1 to skip verification."
    fi

    if [ "$ACTUAL" != "$EXPECTED" ]; then
      die "Checksum mismatch!\n  expected: $EXPECTED\n  actual:   $ACTUAL\nThis may indicate a network interception."
    fi
    ok "Checksum verified"
  else
    printf '\033[33m  ! Skipping checksum verification (CAIPE_NO_VERIFY=1)\033[0m\n'
  fi

  chmod +x "${TMP_DIR}/${BINARY_NAME}"

  # macOS: strip Gatekeeper quarantine flag so the ad-hoc-signed binary runs
  # without the "cannot be opened because the developer cannot be verified" prompt.
  if [ "$OS_NAME" = "darwin" ]; then
    xattr -dr com.apple.quarantine "${TMP_DIR}/${BINARY_NAME}" 2>/dev/null || true
  fi

  DOWNLOADED_BINARY="${TMP_DIR}/${BINARY_NAME}"
}

# ── install ───────────────────────────────────────────────────────────────────

install_binary() {
  SHARE="${CAIPE_SHARE_DIR:-${HOME}/.local/share/caipe}"
  mkdir -p "$SHARE"
  BIN_IN_SHARE="${SHARE}/${BINARY_NAME}"
  install -m 755 "${DOWNLOADED_BINARY}" "${BIN_IN_SHARE}"
  ok "Installed binary to ${BIN_IN_SHARE}"

  DEST="${INSTALL_DIR}/caipe"
  LAUNCHER="${TMP_DIR}/caipe-launcher"

  # Node launcher on PATH — never install the Mach-O binary as ~/.local/bin/caipe (SIGKILL on some Macs).
  cat > "${LAUNCHER}" << 'LAUNCHER_EOF'
#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const args = process.argv.slice(2);
const share = process.env.CAIPE_SHARE_DIR || path.join(os.homedir(), ".local/share/caipe");
const plat = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const bin = path.join(share, "caipe-" + plat + "-" + arch);
if (!fs.existsSync(bin)) {
  process.stderr.write("[caipe] Missing " + bin + ". Re-run install.sh.\n");
  process.exit(1);
}
const env = {
  ...process.env,
  CAIPE_INSTALL_METHOD: "binary",
  CAIPE_BINARY_PATH: bin,
};
const r = spawnSync(bin, args, { stdio: "inherit", env });
process.exit(r.status ?? (r.signal ? 128 : 1));
LAUNCHER_EOF
  chmod +x "${LAUNCHER}"

  if [ ! -w "$INSTALL_DIR" ]; then
    info "Installing to ${INSTALL_DIR} requires elevated privileges…"
    if command -v sudo >/dev/null 2>&1; then
      sudo install -m 755 "${LAUNCHER}" "${DEST}"
    else
      die "Cannot write to ${INSTALL_DIR} and sudo is unavailable. " \
          "Set CAIPE_INSTALL_DIR to a writable directory (e.g. ~/.local/bin)."
    fi
  else
    install -m 755 "${LAUNCHER}" "${DEST}"
  fi

  ok "Installed caipe launcher to ${DEST}"
}

# ── verify installation ───────────────────────────────────────────────────────

verify_install() {
  if ! command -v caipe >/dev/null 2>&1; then
    printf '\n\033[33m  ! caipe is not in your PATH.\033[0m\n'
    printf '    Add %s to your PATH:\n' "$INSTALL_DIR"
    # shellcheck disable=SC2016 # print a literal $PATH for the user's shell
    printf '    export PATH="%s:$PATH"\n\n' "$INSTALL_DIR"
    return
  fi

  INSTALLED_VER=$(caipe --version 2>&1 | head -1)
  ok "caipe is ready: $INSTALLED_VER"
}

# ── main ──────────────────────────────────────────────────────────────────────

main() {
  printf '\n\033[36m  ██████╗ █████╗ ██╗██████╗ ███████╗\033[0m\n'
  printf '\033[36m ██╔════╝██╔══██╗██║██╔══██╗██╔════╝\033[0m\n'
  printf '\033[36m ██║     ███████║██║██████╔╝█████╗  \033[0m\n'
  printf '\033[36m ██║     ██╔══██║██║██╔═══╝ ██╔══╝  \033[0m\n'
  printf '\033[36m ╚██████╗██║  ██║██║██║     ███████╗\033[0m\n'
  printf '\033[36m  ╚═════╝╚═╝  ╚═╝╚═╝╚═╝     ╚══════╝\033[0m\n'
  printf '\n  AI-assisted coding, workflows, and platform engineering\n\n'

  detect_platform
  resolve_version
  download_binary
  install_binary
  verify_install

  printf '\n\033[32mInstallation complete!\033[0m\n'
  printf 'Get started:\n'
  printf '  caipe config set server.url https://your-caipe-server.example.com\n'
  printf '  caipe auth login\n'
  printf '  caipe chat\n\n'
}

main "$@"
