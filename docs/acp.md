# ACP editor integration

CAIPE CLI can run as a local [Agent Client Protocol (ACP)](https://agentclientprotocol.com/)
agent for editors such as [Zed](https://zed.dev/docs/ai/external-agents). The editor
starts `caipe acp` as a subprocess and exchanges newline-delimited JSON-RPC over
stdin and stdout. CAIPE CLI translates that protocol to the remote CAIPE AG-UI
service.

```text
ACP editor  <-- JSON-RPC over stdio -->  caipe acp  <-- HTTPS/AG-UI -->  CAIPE
```

## Requirements

- CAIPE CLI 0.2.26 or newer
- An ACP v1-compatible editor or client
- A reachable CAIPE deployment
- A CAIPE user account with access to at least one agent

Verify the installed command before configuring an editor:

```bash
caipe --version
caipe acp --help
command -v caipe
```

Use the absolute path returned by `command -v caipe` in desktop editors. GUI
applications do not always inherit the same `PATH` as an interactive shell.

## Discovery

The ACP handshake advertises CAIPE's protocol version, capabilities, identity,
and authentication methods after the editor starts the command. It does not
make installed commands discoverable by scanning `PATH`.

There are two ways for an editor to find an ACP agent:

1. Add CAIPE as a custom agent and configure its command and arguments.
2. Install it from the [ACP Agent Registry](https://agentclientprotocol.com/get-started/registry)
   after a CAIPE manifest is published there.

Until a registry entry is available, use custom-agent configuration. The
`caipe acp` subcommand is the launch interface; an additional `--acp` option is
not required.

## Configure CAIPE

Configure the deployment, authenticate, and inspect the accessible agents:

```bash
caipe config set server.url https://caipe.example.com
caipe config set auth.url https://idp.caipe.example.com/realms/caipe
caipe auth login
caipe agents list
```

Optionally select the default agent:

```bash
caipe config set agent.default <agent-id>
```

`CAIPE_SERVER_URL`, `CAIPE_AUTH_URL`, and `CAIPE_DEFAULT_AGENT` can provide the
same settings to the editor process. Environment variables configured only in
a terminal may not be present in a desktop editor; add them to the editor's
agent configuration when needed.

## Configure Zed

Open Zed's Agent Settings, select **External Agents**, choose **Add Agent**, and
then choose **Add Custom Agent**. Configure the absolute CLI path:

```json
{
  "agent_servers": {
    "CAIPE": {
      "type": "custom",
      "command": "/absolute/path/to/caipe",
      "args": ["acp", "--agent", "<agent-id>"],
      "env": {}
    }
  }
}
```

Omit `--agent` and its value to use `agent.default` or the first accessible
agent. Start a new External Agent thread and select **CAIPE**.

If the client advertises terminal-authentication support, CAIPE returns a
`caipe-login` authentication method. The client can relaunch the configured
command with `--login`. Otherwise, run `caipe auth login` in a terminal and
start a new editor session.

In Zed, run `dev: open acp logs` from the command palette to inspect protocol
traffic.

## Command options

```text
caipe acp [--agent <agent-id>] [--no-context]
caipe acp --login
```

| Option | Behavior |
| --- | --- |
| `--agent <agent-id>` | Pins every session in this process to one accessible CAIPE agent. |
| `--no-context` | Skips repository and Git context gathering for new sessions. |
| `--login` | Runs interactive CAIPE authentication and exits instead of starting the protocol server. |

Global `--url`, `--agent`, and environment-based configuration continue to
work. Prefer the ACP command's `--agent` option when configuring an editor.

## Protocol smoke test

Running `caipe acp` directly appears idle because the process is waiting for an
ACP client. Send an `initialize` request to verify the published binary and its
stdout discipline:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"auth":{"terminal":true}}}}' \
  | caipe acp \
  | jq -e '
      .result.protocolVersion == 1 and
      .result.agentInfo.name == "caipe-cli" and
      .result.authMethods[0].id == "caipe-login"
    '
```

A successful test prints `true`. It verifies process startup, JSON-RPC framing,
ACP v1 negotiation, agent metadata, terminal-auth discovery, and clean stdout.
It does not contact the CAIPE service or verify an authenticated session.

## End-to-end acceptance test

After the handshake succeeds, test against a real deployment from an editor:

1. Start a CAIPE External Agent thread and send a simple text prompt.
2. Send a follow-up prompt in the same thread to verify conversation reuse.
3. Ask the selected agent to use one of its configured server-side tools and
   verify that the editor shows the tool lifecycle and result.
4. Cancel a long-running response and verify that streaming stops.
5. Start two threads concurrently and verify that their messages and tools do
   not cross sessions.
6. Remove or expire the local credential and verify that the client offers the
   CAIPE login method or reports `auth_required` with `caipe auth login` as the
   recovery command.

## Supported capabilities

- ACP v1 over newline-delimited JSON-RPC on stdin and stdout
- Independent concurrent sessions
- Multi-turn CAIPE conversation reuse
- Prompt and request cancellation
- Text and resource-link prompt blocks
- Streaming agent-message chunks
- Tool-call start, arguments, completion, and result updates
- Existing server-side tools and MCP servers configured on the selected CAIPE
  agent

ACP mode reserves stdout for JSON-RPC. Diagnostics are written to stderr. The
normal startup update check, logo, and interactive UI do not run.

## Current limitations

- Session load/resume is not advertised.
- Image, audio, and embedded-resource prompt blocks are not advertised.
- Client filesystem and terminal requests are not advertised.
- Additional workspace directories are not supported.
- MCP servers supplied by the editor in `session/new` are rejected. A
  local-to-remote MCP bridge is required before those definitions can be
  connected safely. This does not affect MCP servers already configured on the
  selected CAIPE agent.
- Remote ACP transports are not supported; the editor must launch the local
  CLI process.
- Protocol versions other than ACP v1 are not supported.

## Troubleshooting

### The editor cannot find `caipe`

Run `command -v caipe` and use that absolute path as the configured command.
Confirm that the same path reports version 0.2.26 or newer.

### The process starts but shows no output

This is normal until the client sends JSON-RPC. Use the protocol smoke test to
verify the command outside the editor.

### The client reports `auth_required`

Run `caipe auth login`, confirm `caipe auth status`, and start a new ACP
session. Also confirm that the editor process receives the expected server and
authentication URLs.

### The client reports that MCP servers are unsupported

Remove editor-supplied MCP servers from the ACP session. Configure required MCP
servers on the CAIPE agent in the upstream service instead.

### Protocol parsing fails

Check that the configured command is `caipe` with `acp` as its first argument.
ACP mode must not be wrapped by a shell script that writes banners, update
messages, or other text to stdout.

