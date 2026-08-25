# CAIPE CLI

Terminal client for [CAIPE](https://github.com/cnoe-io/ai-platform-engineering): chat with dynamic agents, manage skills, and run headless prompts against a remote CAIPE UI / BFF.

## TL;DR

**Install CAIPE CLI:**

```bash
curl -fsSL https://raw.githubusercontent.com/cnoe-io/caipe-cli/main/install.sh | sh
```

The installer downloads the latest verified release and asks where to place the
`caipe` launcher. Press Enter for `~/.local/bin` (recommended, no password),
choose `~/.bin`, or stage a launcher for an explicit system-wide install. The
web-fetched script never invokes `sudo` or reads a password.

**Point at your CAIPE deployment, sign in, chat:**

```bash
caipe config set server.url https://caipe.example.com
caipe config set auth.url https://idp.caipe.example.com/realms/caipe
caipe auth login
caipe agents list
caipe chat --agent '<id-from-agents-list>'
```

Type messages at the `❯` prompt. **`/`** for commands, **`Ctrl+O`** to pick an agent, **`Ctrl+D`** to exit.

Prompt line editing is implemented in-tree (`src/chat/line-edit.ts`, Apache-2.0): common bash/emacs keys (Ctrl+A/E/K/U/W/Y, Alt+b/f/d, Ctrl+R history search, etc.). It does **not** use GNU Readline or other GPL line-editing libraries.

Other host (UI serves OAuth on the same URL): set only `server.url`, then `caipe auth login` and `caipe chat`.

---

- macOS or Linux on arm64 or x64
- `curl` and Node.js 20 or newer
- A reachable CAIPE deployment (API + OAuth)

Optional: **keytar** only if you set `auth.credential-storage` to `keychain`.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/cnoe-io/caipe-cli/main/install.sh | sh
```

The installer asks you to choose:

1. `~/.local/bin` — recommended, no password
2. `~/.bin` — user-owned alternative, no password
3. `/usr/local/bin` — stages the launcher and prints separate review/install commands

Press Enter to accept option 1. In a non-interactive environment, option 1 is
selected automatically. Then verify with `caipe --version`. If the selected
directory is not already on `PATH`, the installer prints the exact command to
add it.

Automation can bypass the prompt with `CAIPE_INSTALL_DIR`. For example, choose
the user-owned `~/.bin` directory without a password:

```bash
curl -fsSL https://raw.githubusercontent.com/cnoe-io/caipe-cli/main/install.sh \
  | CAIPE_INSTALL_DIR="$HOME/.bin" sh
```

Choose a system-wide directory explicitly:

```bash
curl -fsSL https://raw.githubusercontent.com/cnoe-io/caipe-cli/main/install.sh \
  | CAIPE_INSTALL_DIR=/usr/local/bin sh
```

The web installer downloads and verifies the binary, stages the launcher under
`~/.local/share/caipe`, and stops. It never invokes `sudo`. Review the staged
launcher, then separately run the exact `sudo mkdir` and `sudo install` commands
it prints.

In every case, `CAIPE_INSTALL_DIR` controls only the small launcher on `PATH`;
the platform binary is stored under `~/.local/share/caipe` by default.

The installer downloads the latest multi-architecture GitHub release and
verifies its SHA-256 checksum. Pin a release when reproducibility matters:

```bash
curl -fsSL https://raw.githubusercontent.com/cnoe-io/caipe-cli/main/install.sh \
  | CAIPE_VERSION=0.2.22 sh
```

The npm package is not published yet; use `install.sh` until it is available.

### Updates

Interactive chat checks GitHub Releases at most once every 24 hours. Known
binary installs update automatically; other install types receive one
notification per release. Update manually:

```bash
caipe update --check    # inspect only
caipe update            # download, verify, smoke-test, and install
```

Downloaded binaries must match `caipe-checksums.txt` and pass `--version`
before atomically replacing the installed binary. npm-managed installations
delegate an explicit update to npm. Verified binary updates install
automatically by default:

```bash
caipe config set updates.mode notify  # auto (default), notify, or off
```

Source or unknown launchers fall back to a notification and an actionable
manual update command. Set `CAIPE_NO_UPDATE_CHECK=1` for a one-off invocation.

Every commit to `main` is released after the full CI workflow succeeds. The
release workflow creates the next patch tag, publishes checksummed binaries,
signs them with cosign, and publishes the matching npm packages.

---

## Developer guide

### Build from source

```bash
git clone https://github.com/cnoe-io/caipe-cli.git
cd caipe-cli
bun install
npm run compile          # native binary → dist/caipe
./dist/caipe --version
```

For a development checkout, run `npm link` or use `node bin/caipe.cjs` rather
than copying the compiled binary into `PATH`.

### Other build targets

| Command | Output |
|--------|--------|
| `npm run dev -- chat` | Run via **tsx** (fast iteration, no compile) |
| `npm run build` | Node bundle `dist/bundle.cjs` (keytar external) |
| `node bin/caipe.cjs chat` | Entry script: platform binary → `dist/caipe` → bundle → tsx |
| `npm run compile:all` | Cross-compile all platform binaries in `dist/` |

**Compile note:** `npm run compile` uses Bun with **`keytar` external** so the default **encrypted-file** credential store works without building native modules. If you use the keychain backend:

```bash
npm install keytar
npm rebuild keytar
caipe config set auth.credential-storage keychain
```

### Verify the build

```bash
npm run lint
npm test
```

### Publish a release

The `Publish caipe CLI` GitHub Actions workflow runs for semantic-version tags.
It verifies the source, builds and smoke-tests all four supported binaries,
publishes a GitHub release with checksums and keyless cosign signatures, then
publishes the four platform packages and the top-level `caipe` npm package.

This distribution path is for maintainers and is not a working user install
method until the first tagged workflow completes successfully.

| Operating system | Architecture | npm platform package | Release asset |
|------------------|--------------|----------------------|---------------|
| macOS | Apple Silicon (arm64) | `caipe-darwin-arm64` | `caipe-darwin-arm64` |
| macOS | Intel (x64) | `caipe-darwin-x64` | `caipe-darwin-x64` |
| Linux | arm64 | `caipe-linux-arm64` | `caipe-linux-arm64` |
| Linux | x64 | `caipe-linux-x64` | `caipe-linux-x64` |

```bash
git tag 0.2.22
git push origin 0.2.22
```

The GitHub `npm-publish` environment must provide an `NPM_TOKEN` secret with
permission to publish `caipe` and the four `caipe-<os>-<arch>` packages.
Prerelease tags such as `0.2.22-rc.1` publish to npm's `next` dist-tag; stable
versions publish to `latest`.

---

## Configure and sign in

Settings live in **`~/.config/caipe/settings.json`**.

### Typical setup (single host)

When the UI exposes OAuth and `/.well-known/agent.json` on the same host:

```bash
caipe config set server.url https://your-caipe.example.com
caipe auth login
caipe agents list
caipe config set agent.default agent-sre   # id from agents list; optional
caipe chat
```

`config set server.url` also sets **`auth.url`** to the same value.

### Split API vs IdP

On some deployments the BFF may not expose `/oauth/authorize` yet. Point the
**API** at CAIPE and **OAuth** at Keycloak:

```bash
caipe config set server.url https://caipe.example.com
caipe config set auth.url https://idp.caipe.example.com/realms/caipe
rm -f ~/.config/caipe/agent-config.json
caipe auth logout    # if you have stale tokens
caipe auth login
```

Optional IdP shortcut (e.g. Duo SSO):

```bash
caipe config set auth.idp-hint duo-sso
# or: export CAIPE_IDP_HINT=duo-sso
```

### Environment overrides

| Variable | Purpose |
|----------|---------|
| `CAIPE_SERVER_URL` | BFF base URL (agents, chat stream) |
| `CAIPE_AUTH_URL` | OAuth / discovery base (login) |
| `CAIPE_DEFAULT_AGENT` | Default dynamic agent id (overrides `agent.default` in settings) |
| `CAIPE_UPDATE_MODE` | CLI update behavior: `auto` (default), `notify`, or `off` |
| `CAIPE_NO_UPDATE_CHECK` | Set to `1` to skip the startup update check |
| `CAIPE_AUTH_REALM` | Keycloak realm name for IdP heuristics (default `caipe`) |
| `CAIPE_PLAIN_TERMINAL` | Set to `1` to disable rich markdown, alt screen, and inline images |
| `CAIPE_NO_ALT_SCREEN` | Set to `1` to keep chat in the normal scrollback buffer |
| `CAIPE_NO_INLINE_IMAGES` | Set to `1` to disable iTerm2 inline image rendering |
| `CAIPE_STREAM_BUFFER_MS` | Token flush interval while streaming (default `50`) |
| `CAIPE_STREAM_PLAIN` | Set to `1` for legacy plain-text chunk streaming (no live markdown colors) |
| `CAIPE_IDP_HINT` | Keycloak `kc_idp_hint` |
| `CAIPE_CALLBACK_PORT` | OAuth loopback port (default `8085`; the IdP must register any override) |
| `CAIPE_TOKEN` | Bearer token (headless / CI) |
| `CAIPE_KB_URL` | Knowledge Base RAG API base URL |
| `CAIPE_TENANT_ID` | `X-Tenant-Id` for KB API calls (when not using default tenant) |
| `CAIPE_API_KEY` | API key where supported |

### Auth troubleshooting

| Symptom | What to do |
|---------|------------|
| `Already authenticated as (unknown)` | `caipe auth logout` then `caipe auth login`, or upgrade to a build with session fixes |
| Browser **404** on `/oauth/authorize` | Set `auth.url` to the realm issuer (see the split API/IdP section above) |
| OAuth callback port `8085` is busy | CAIPE automatically retries on IPv6 loopback. Otherwise use `--device`, `--manual`, or `--callback-port <port>` when that port is registered with the IdP. |
| `Invalid client_type: cli` | CLI retries with `slack` on older BFFs; upgrade UI to add `cli` to `VALID_CLIENT_TYPES` |
| **403** `agent#use` / `pdp_denied` | Run `caipe agents list`, then `caipe chat --agent <id>` for an agent you can use; ask admin for OpenFGA **agent#use** if the list is empty |

---

## Use the CLI

### Interactive chat (default)

```bash
caipe                  # same as caipe chat
caipe chat --agent my-agent
```

In the REPL:

- **`/`** — slash commands (`/agents`, `/skills`, `/login`, `/help`, `/exit`, …)
- **`!cmd`** — run a shell command and inject output
- **`Esc`** — abort streaming

### Agents and skills

```bash
caipe agents list
caipe agents info <name>
caipe skills list
caipe skills install <name>
```

### Headless / CI

```bash
caipe chat --headless --prompt "Summarize open incidents"
caipe chat --headless --prompt-file question.txt --output json
caipe chat --headless --token "$JWT" --prompt "health check"
```

### ACP editor integration

`caipe acp` exposes accessible CAIPE agents to editors that support the
[Agent Client Protocol](https://agentclientprotocol.com/). The editor launches
the CLI as a local subprocess; the CLI translates ACP JSON-RPC on stdio to the
remote CAIPE AG-UI service.

Authenticate and select an agent before configuring the editor:

```bash
caipe auth login
caipe agents list
caipe config set agent.default <agent-id>  # optional
```

For [Zed custom agents](https://zed.dev/docs/ai/external-agents#custom-agents),
add an `agent_servers` entry to `settings.json`:

```json
{
  "agent_servers": {
    "CAIPE": {
      "type": "custom",
      "command": "caipe",
      "args": ["acp", "--agent", "<agent-id>"],
      "env": {}
    }
  }
}
```

Omit `--agent <agent-id>` to use `agent.default` or the first accessible
agent. `CAIPE_SERVER_URL`, `CAIPE_AUTH_URL`, and `CAIPE_DEFAULT_AGENT` work in
the editor process as they do in the terminal. ACP clients that support
terminal authentication can relaunch the command with `--login`; otherwise,
run `caipe auth login` separately when the client reports `auth_required`.

Current ACP support:

- ACP v1 over newline-delimited JSON-RPC on stdin/stdout
- concurrent sessions, multi-turn CAIPE conversations, and cancellation
- text and resource-link prompts
- streaming agent text and tool-call lifecycle updates
- existing CAIPE server-side tools and MCP servers configured on the selected agent

Current limitations:

- Session load/resume, image/audio prompts, and client filesystem or terminal requests are not advertised.
- MCP servers supplied by the editor in `session/new` are rejected with an explicit error. A local-to-remote MCP bridge is required before these can be connected safely. This does not affect MCP servers already configured on the CAIPE agent.
- Remote ACP transports and the draft ACP v2 protocol are not supported.

ACP mode reserves stdout for JSON-RPC. Diagnostics go to stderr and the normal
startup update check, logo, and interactive UI do not run. In Zed, use
`dev: open acp logs` to inspect protocol traffic.

### Auth commands

```bash
caipe auth status
caipe auth login --force
caipe auth login              # PKCE in isolated Chrome/Chromium (default)
caipe auth login --system-browser   # use default browser profile (can affect Web UI)
caipe auth login --device      # device code flow
caipe auth login --manual      # paste authorization code
caipe auth logout
```

**OAuth browser:** By default the CLI opens Chrome/Chromium with a **temporary profile** so logging in does not overwrite cookies for an open caipe-ui tab. Set `CAIPE_CHROMIUM_PATH` if Chrome is non-standard. `CAIPE_AUTH_BROWSER=system` restores the old behavior. `CAIPE_AUTH_HEADLESS=1` uses headless mode (often breaks MFA).

### Knowledge Base (scripts / CI)

Non-interactive commands talk to the [CAIPE RAG REST API](https://github.com/cnoe-io/ai-platform-engineering/tree/main/ai_platform_engineering/knowledge_bases/rag) and **always print JSON** to stdout (errors as JSON on stderr).

```bash
caipe config set kb.url https://your-kb-api.example.com   # or export CAIPE_KB_URL
caipe auth login   # or export CAIPE_TOKEN / client credentials for CI

caipe kb user info
caipe kb datasources list
caipe kb documents list <datasource-id> --limit 50
caipe kb query --query "how do I deploy SSE?"
caipe kb chunk get '<chunk-id>'

caipe kb ingest url --url https://docs.example.com/
caipe kb ingest file ./README.md ./guide.pdf --owner-team-slug my-team
caipe kb job get <job-id>
```

Shared flags on `caipe kb`: `--kb-url`, `--token`, `--tenant-id` (or `CAIPE_TENANT_ID`).

---

## Configuration reference

| Key | Description |
|-----|-------------|
| `server.url` | CAIPE UI / BFF HTTPS base URL |
| `auth.url` | OAuth and discovery base (Keycloak realm URL or UI URL) |
| `agent.default` | Default dynamic agent id for `caipe chat` when `--agent` is omitted |
| `auth.idp-hint` | Skip Keycloak login chooser (`kc_idp_hint`) |
| `kb.url` | Knowledge Base RAG REST API base URL |
| `updates.mode` | Daily CLI update behavior: `auto` (default), `notify`, or `off` |
| `auth.apiKey` | Static API key (headless alternative) |
| `auth.credential-storage` | `encrypted-file` (default) or `keychain` |

**Rich terminal output (interactive chat):** Markdown is rendered with **react-markdown** + **remark-gfm** as native Ink components (no ANSI markdown strings). Diffs use Ink colors. Block streaming caches completed sections in `<Static>`; the active tail updates in place. Tool runs show in the footer. Chat uses the **alternate screen** unless `CAIPE_NO_ALT_SCREEN=1` or `CAIPE_PLAIN_TERMINAL=1`. Legacy plain streaming: `CAIPE_STREAM_PLAIN=1`.

**Default credentials:** encrypted file at `~/.config/caipe/credentials.enc` (AES-256-GCM, machine-derived key). No Keychain prompts unless you opt into `keychain`.

---

## Command reference

| Command | Description |
|---------|-------------|
| `caipe` / `caipe chat` | Interactive REPL |
| `caipe acp [--agent <id>]` | ACP v1 agent bridge over stdio for compatible editors |
| `caipe auth login\|logout\|status` | OAuth session |
| `caipe config set\|get\|unset\|discover` | Settings (`discover` sets `auth.url` via well-known URLs or deployment hostname heuristics) |
| `caipe agents list\|info` | Server agents |
| `caipe kb …` | KB query, read chunks, ingest, jobs, RBAC (`user info`) — JSON only |
| `caipe skills list\|install\|preview\|update` | Skill catalog |
| `caipe update [--check]` | Check for or install a verified CLI release |
| `caipe memory` | Project memory files |
| `caipe commit` | DCO-aware commit helper |

Global flags: `--agent`, `--url`, `--json`, `--no-color`, `-v` / `--version`.

---

## Project layout

```
caipe-cli/
  src/           TypeScript source
  bin/caipe.cjs  npm/npx launcher
  dist/          compile output (gitignored)
  tests/         Vitest
  setup-caipe-cli.sh
  install.sh
```

---

## Troubleshooting

### `Invalid client_type: "cli"`

Older BFFs only allow `webui`, `slack`, and `webex`. The CLI tries **`slack` first**, then `cli`, when creating conversations. Rebuild from latest `main` if you still see a `cli`-only error.

### OAuth 404 on `/oauth/authorize`

Set **`server.url`** to the UI/BFF, then run **`caipe config discover`**.
Discovery tries, in order: `/.well-known/agent.json`, OIDC metadata on the BFF
host, then deployment-specific hostname heuristics. Override the realm with
**`CAIPE_AUTH_REALM`**. You can still set **`auth.url`** manually (for example,
`https://idp.caipe.example.com/realms/caipe`).

---

## License

Apache-2.0
