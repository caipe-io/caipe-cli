# ACP client integration

CAIPE CLI can run as a local [Agent Client Protocol (ACP)](https://agentclientprotocol.com/)
agent for external applications and editors such as [Zed](https://zed.dev/docs/ai/external-agents). The editor
starts `caipe acp` as a subprocess and exchanges newline-delimited JSON-RPC over
stdin and stdout. CAIPE CLI uses the existing authenticated CAIPE BFF conversation, message, and
AG-UI streaming APIs. It does not introduce a separate agent gateway or history database.

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

## Unattended applications

Use the same `caipe acp --agent <agent-id> --no-context` command from an ACP application.
Set `CAIPE_SERVER_URL` and one of these credential sources:

| Priority | Credential | Behavior |
| --- | --- | --- |
| 1 | `CAIPE_TOKEN` | Sends the supplied bearer token; the BFF validates it. |
| 2 | `CAIPE_API_KEY` or `auth.apiKey` | Uses the configured API key where the deployment supports it. |
| 3 | `CAIPE_CLIENT_ID` and `CAIPE_CLIENT_SECRET` | Exchanges and refreshes client-credentials tokens using the configured OAuth endpoint. |
| 4 | Stored OAuth login | Used only when no unattended credentials are configured. |

`CAIPE_AUTH_URL` selects the OAuth service when it differs from the BFF. A bearer-token
application needs only `CAIPE_SERVER_URL` and `CAIPE_TOKEN`. Empty, incomplete, rejected,
or expired configured credentials do not silently fall back to another signed-in account.
OAuth exchange failures report a status without exposing token responses or secrets.
Headless clients do not inherit the identity of a different user's stored OAuth session
in their agent context. The BFF derives the authenticated caller from the credential.

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
4. Cancel a long-running response and verify the backend cancellation request and partial history.
5. Reload the returned session ID and verify that no replacement conversation is created.
6. Trigger a tool approval and a form: verify actual selected decisions or a paused CAIPE review link.
7. Start two threads concurrently and verify that their messages and tools do
   not cross sessions.
8. Remove or expire the local credential and verify that the client offers the
   CAIPE login method or reports `auth_required` with `caipe auth login` as the
   recovery command.

## Supported capabilities

- ACP v1 over newline-delimited JSON-RPC on stdin and stdout
- Independent concurrent sessions
- Canonical CAIPE conversation creation, authenticated session loading, and history replay
- Multi-turn CAIPE conversation reuse
- Authenticated remote cancellation on `session/cancel`, request abort, stdin EOF, and SIGTERM
- Selected approve/reject responses through standard `session/request_permission`
- Text and resource-link prompt blocks
- Streaming agent-message chunks
- Tool-call start, arguments, completion, and result updates
- Existing server-side tools and MCP servers configured on the selected CAIPE
  agent

ACP mode reserves stdout for JSON-RPC. Diagnostics are written to stderr. The
normal startup update check, logo, and interactive UI do not run.

## Session identity and history

`session/new` creates a conversation through `POST /api/chat/conversations` and returns
its server-assigned ID as the ACP session ID. The client stores that reference to resume
later; it does not create an independent CAIPE execution namespace. `session/load` calls
the BFF again with the current credential, verifies writable owner/shared access and the
selected agent, replays persisted user/assistant messages, and restores pending native
human-input state. Missing, read-only, automated-history, and different-agent conversations
are rejected without creating replacement threads. Agent and conversation permissions
are checked by the BFF again on subsequent execution requests.

ACP turns use the existing `/api/chat/conversations/<id>/messages` upsert API. The user
message is stored before execution; final, paused, and partial assistant output is stored
when the stream closes. Stable message IDs keep immediate approval resumes in one
assistant record. These records are visible in CAIPE history; agent execution state stays
in the existing native checkpoints. The CLI writes only its own turns, while the browser
continues to write browser turns. This is not a detached execution or crash-recovery service:
an abrupt process kill can prevent the final transcript write.

Cancellation sends the authenticated `/api/v1/chat/stream/cancel` request as well as
aborting local streaming. Shutdown stops admitting prompts and drains cancellation and
history cleanup for a bounded period. Runtime cancellation remains cooperative.

## Human input and approvals

For tool approval, the CLI forwards native tool arguments and allowed approve/reject
choices as standard ACP permission options. It resumes only the option actually selected
by the client. Batched tools retain their individual decisions. Unsupported, cancelled,
edit-only, or generic form requests remain paused; no default approval or fabricated
form response is sent.

A generic ACP client receives an actionable CAIPE conversation link and a `refusal`
response with `_meta.caipeStatus: "input_required"`, `_meta.caipePendingInterrupt`, and
`_meta.caipeConversationUrl`. The refusal describes a pending interaction rather than a
completed agent run. The native checkpoint retains the full form or approval request.
The CAIPE review page still enforces conversation permissions: an application service
account's conversation needs an admitted human reader/writer grant for a person to review it.

Clients that advertise `clientCapabilities._meta["caipe.io/native-acp"]: 1` also receive
the `_caipe/event` extension request with `{sessionId, event: {kind: "input_required", ...}}`.
The event includes the original interrupt, native fields/choices, interrupt ID and
conversation URL. A client acknowledges delivery with `{}`; acknowledgment never approves
or resumes the agent. New/load/prompt responses also retain the conversation link and
pending-input metadata. After input is resolved in CAIPE, reload the same session to
refresh its pending state.

A client explicitly negotiating `clientCapabilities._meta.caipeNativeHumanInput: 1` may
submit `_meta.caipeResumeData` with a native `form_input` response on `session/prompt`.
This extension is restricted to a matching pending form. Tool permissions continue to
use standard ACP selected-option responses. Native extensions do not change the wire
protocol version or the BFF authentication contract.

## Current limitations
- Image, audio, and embedded-resource prompt blocks are not advertised.
- Client filesystem and terminal requests are not advertised.
- Additional workspace directories are not supported.
- MCP servers supplied by the editor in `session/new` are rejected. A
  local-to-remote MCP bridge is required before those definitions can be
  connected safely. This does not affect MCP servers already configured on the
  selected CAIPE agent.
- ACP transport to the CLI is stdio; applications launch the local CLI process.
  The CLI uses existing HTTPS APIs to reach CAIPE, with no new WebSocket endpoint.
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

