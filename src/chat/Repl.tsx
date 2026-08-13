/**
 * CAIPE interactive chat REPL built with Ink 5 + React 18.
 *
 * Architecture:
 *   - Completed turns live in <Static> with rendered markdown.
 *   - While streaming: static wait line (1s ticks; optional CAIPE_SPINNER=1 animation).
 *   - User prompts: full-width dim bar; optional * Recap: line above assistant markdown.
 *   - Tools: summary + shell tree while running; persisted tool-activity block when done.
 *   - Local shell (`! cmd`, `| pipe`) requires HITL approval unless CAIPE_SHELL_AUTO_APPROVE=1.
 *   - Assistant markdown: marked-terminal ANSI (one shot after each turn).
 */

import { Box, Text, useApp, useInput, useStdout } from "ink";
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";

import { AgentPicker } from "../agents/AgentPicker.js";
import { filterAgents, sortAgentsForPicker } from "../agents/picker.js";
import { fetchAgents, getAgent } from "../agents/registry.js";
import type { Agent } from "../agents/types.js";
import { loginBrowser } from "../auth/oauth.js";
import { getValidToken } from "../auth/tokens.js";
import {
  authEndpoints,
  getAuthUrl,
  getServerUrl,
  readSettings,
  settingsJsonPath,
} from "../platform/config.js";
import { ToolActivityPanel, type ToolActivityRun } from "../platform/display.js";
import { getMarkdownLayoutWidth, getTerminalWidth } from "../platform/markdown.js";
import { maxStaticToolTreeRows } from "../platform/terminal/repl-ui.js";
import { fetchSupervisorSkills } from "../skills/catalog.js";
import { SessionPicker } from "./SessionPicker.js";
import { ShellApprovalPrompt } from "./ShellApprovalPrompt.js";
import { StaticHistory } from "./StaticHistory.js";
import { type LiveToolRefEntry, StreamingStatusPanel } from "./StreamingStatusPanel.js";
import type { ChatSession } from "./history.js";
import {
  type SessionSummary,
  filterSessions,
  listSessions,
  loadSession,
  patchSessionConversationId,
  resolveSessionIdByArg,
  saveSession,
} from "./history.js";
import {
  type LineEditSession,
  applyLineEditKey,
  createLineEditSession,
  insertText,
  lastWordFromHistoryLine,
} from "./line-edit.js";
import { streamPlainTextEnabled } from "./markdown-stream.js";
import {
  PICKER_PAGE_JUMP,
  SLASH_PICKER_VISIBLE,
  clampPickerIndex,
  movePickerIndex,
  pagePickerIndex,
  pickerWindow,
} from "./picker-nav.js";
import { parseInput, pipeThrough, runShellCommand } from "./pipes.js";
import { extractRecap } from "./recap.js";
import { type ShellApprovalRequest, isShellHitlEnabled } from "./shell-hitl.js";
import { FOOTER_HINT_IDLE, SHORTCUT_AGENT_PICKER, SHORTCUT_SLASH_COMMANDS } from "./shortcuts.js";
import { createAdapter } from "./stream.js";
import type { StreamAdapter } from "./stream.js";
import { commandFromToolArgsBuffer } from "./tool-detail.js";
import { patchFromToolCall } from "./tool-patch.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReplProps {
  session: ChatSession;
  adapter: StreamAdapter;
  initialAgent: Agent;
  systemContext: string;
  serverUrl?: string;
  onExit: (session: ChatSession) => void;
}

/**
 * Every item in the <Static> list.  Once pushed, it is rendered once and
 * never touched again — this is what prevents flashing.
 */
type StaticItem =
  | ({ kind: "user"; text: string } & { _key: number })
  | ({ kind: "recap"; text: string } & { _key: number })
  | ({ kind: "assistant"; text: string } & { _key: number })
  | ({ kind: "assistant-plain"; text: string } & { _key: number })
  | ({ kind: "assistant-segment"; text: string; lead?: boolean; diff?: boolean } & { _key: number })
  | ({ kind: "chunk"; text: string } & { _key: number })
  | ({ kind: "tool-activity"; elapsed: number; runs: ToolActivityRun[]; omittedCount?: number } & {
      _key: number;
    })
  | ({ kind: "tool"; name: string } & { _key: number });
type StaticItemInput =
  | { kind: "user"; text: string }
  | { kind: "recap"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "assistant-plain"; text: string }
  | { kind: "assistant-segment"; text: string; lead?: boolean; diff?: boolean }
  | { kind: "chunk"; text: string }
  | { kind: "tool-activity"; elapsed: number; runs: ToolActivityRun[]; omittedCount?: number }
  | { kind: "tool"; name: string };

// Internal message for history tracking (not rendered directly)
type HistoryEntry = { role: "user" | "assistant"; content: string };

function streamTimingMs(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** How often to flush SSE tokens to the screen while streaming. */
const STREAM_TOKEN_BUFFER_MS = streamTimingMs("CAIPE_STREAM_BUFFER_MS", 50);

// ---------------------------------------------------------------------------
// Slash command registry
// ---------------------------------------------------------------------------

interface SlashCommand {
  name: string;
  description: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/clear", description: "Clear conversation context" },
  { name: "/compact", description: "Summarize and compress history" },
  { name: "/login", description: "Re-authenticate (opens browser)" },
  { name: "/settings", description: "View or edit CLI configuration" },
  { name: "/exit", description: "End session and save history" },
  { name: "/skills", description: "Show skills loaded in supervisor" },
  { name: "/agents", description: "Switch to a different agent" },
  { name: "/resume", description: "Pick a saved session (↑↓ Enter)" },
  { name: "/memory", description: "Edit memory file" },
  { name: "/help", description: "Show available commands" },
];

// ---------------------------------------------------------------------------
// SlashPicker
// ---------------------------------------------------------------------------

interface SlashPickerProps {
  input: string;
  selectedIndex: number;
  filtered: SlashCommand[];
}

function SlashPicker({ input, selectedIndex, filtered }: SlashPickerProps): React.ReactElement {
  const query = input.slice(1).toLowerCase();
  const safeIndex = clampPickerIndex(selectedIndex, filtered.length);
  const { start, end } = pickerWindow(filtered.length, safeIndex, SLASH_PICKER_VISIBLE);
  const slice = filtered.slice(start, end);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      marginX={1}
      marginBottom={0}
      paddingX={1}
    >
      <Box>
        <Text bold color="cyan">
          Slash commands
        </Text>
        <Text dimColor> · ↑↓ · PgUp/PgDn · Tab complete · Enter run · Esc dismiss</Text>
      </Box>
      {filtered.length === 0 ? (
        <Text dimColor>No commands match "{query}"</Text>
      ) : (
        <>
          {start > 0 ? <Text dimColor>{`  ↑ ${start} more above`}</Text> : null}
          {slice.map((cmd, i) => {
            const idx = start + i;
            const sel = idx === safeIndex;
            return (
              <Box key={cmd.name}>
                <Text color={sel ? "cyan" : undefined}>{sel ? "▶ " : "  "}</Text>
                <Text color={sel ? "cyan" : "white"} bold={sel}>
                  {cmd.name.padEnd(14)}
                </Text>
                <Text dimColor={!sel} color={sel ? "white" : undefined}>
                  {cmd.description}
                </Text>
              </Box>
            );
          })}
          {end < filtered.length ? (
            <Text dimColor>{`  ↓ ${filtered.length - end} more below`}</Text>
          ) : null}
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// InputBar (memoized — props rarely change during streaming)
// ---------------------------------------------------------------------------

export type PickerNavigation = "none" | "slash" | "agent" | "session";

interface InputBarProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onUp: () => void;
  onDown: () => void;
  onPageUp?: () => void;
  onPageDown?: () => void;
  onTabComplete?: () => void;
  onEscape: () => void;
  /** Ctrl+O — open agent picker */
  onOpenAgentPicker?: () => void;
  /** Focus slash command menu */
  onOpenSlashPicker?: () => void;
  pickerNav: PickerNavigation;
  disabled?: boolean;
  /** Previous inputs for Up/Down history navigation */
  history?: string[];
}

/**
 * InputBar with bash/emacs-style keybindings (clean-room; see line-edit.ts).
 *
 * Does not use GNU Readline or other GPL line-editing libraries.
 */
function InputBar({
  value,
  onChange,
  onSubmit,
  onUp,
  onDown,
  onPageUp,
  onPageDown,
  onTabComplete,
  onEscape,
  onOpenAgentPicker,
  // onOpenSlashPicker: accepted for parity with onOpenAgentPicker, but no
  // keybinding in this component fires it yet (see call site below).
  pickerNav,
  disabled = false,
  history = [],
}: InputBarProps): React.ReactElement {
  const [cursor, setCursor] = useState(value.length);
  const [historyIdx, setHistoryIdx] = useState(history.length);
  const stashedRef = useRef("");
  const editSessionRef = useRef<LineEditSession>(createLineEditSession());
  const [revSearch, setRevSearch] = useState<{ query: string; match: number } | null>(null);

  useEffect(() => {
    setCursor((c) => Math.min(c, value.length));
  }, [value]);

  useEffect(() => {
    setHistoryIdx(history.length);
  }, [history.length]);

  const historyPrev = useCallback(() => {
    if (history.length === 0 || historyIdx <= 0) return;
    if (historyIdx === history.length) stashedRef.current = value;
    const idx = historyIdx - 1;
    setHistoryIdx(idx);
    const entry = history[idx];
    if (!entry) return;
    onChange(entry);
    setCursor(entry.length);
  }, [history, historyIdx, value, onChange]);

  const historyNext = useCallback(() => {
    if (historyIdx >= history.length) return;
    const idx = historyIdx + 1;
    setHistoryIdx(idx);
    const entry = idx === history.length ? stashedRef.current : history[idx]!;
    onChange(entry);
    setCursor(entry.length);
  }, [history, historyIdx, onChange]);

  const revMatches = useCallback(
    (query: string): string[] => {
      if (history.length === 0) return [];
      const q = query.toLowerCase();
      return history.filter((h) => h.toLowerCase().includes(q)).reverse();
    },
    [history],
  );

  const applyOutcome = useCallback(
    (nextValue: string, nextCursor: number) => {
      onChange(nextValue);
      setCursor(nextCursor);
    },
    [onChange],
  );

  const pickerActive = pickerNav !== "none";

  useInput(
    (char, key) => {
      if (disabled) return;

      const termKey = {
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        leftArrow: key.leftArrow,
        rightArrow: key.rightArrow,
        return: key.return,
        escape: key.escape,
        backspace: key.backspace,
        delete: key.delete,
        tab: key.tab,
      };

      if (revSearch) {
        if (termKey.escape || (termKey.ctrl && char === "g")) {
          setRevSearch(null);
          return;
        }
        if (termKey.return) {
          const matches = revMatches(revSearch.query);
          const pick = matches[revSearch.match];
          if (pick) {
            applyOutcome(pick, pick.length);
            setHistoryIdx(history.length);
          }
          setRevSearch(null);
          return;
        }
        if (termKey.ctrl && char === "r") {
          const matches = revMatches(revSearch.query);
          if (matches.length > 0) {
            setRevSearch((s) => (s ? { ...s, match: (s.match + 1) % matches.length } : s));
            const m = matches[(revSearch.match + 1) % matches.length];
            if (m) applyOutcome(m, m.length);
          }
          return;
        }
        if (termKey.backspace || termKey.delete) {
          setRevSearch((s) => (s ? { ...s, query: s.query.slice(0, -1), match: 0 } : s));
          return;
        }
        if (char && char.length === 1 && !termKey.ctrl && !termKey.meta) {
          setRevSearch((s) => (s ? { ...s, query: s.query + char, match: 0 } : s));
          const nextQ = revSearch.query + char;
          const m = revMatches(nextQ)[0];
          if (m) applyOutcome(m, m.length);
          return;
        }
        return;
      }

      if (termKey.upArrow || (termKey.ctrl && char === "p")) {
        if (pickerActive) onUp();
        else historyPrev();
        return;
      }
      if (termKey.downArrow || (termKey.ctrl && char === "n")) {
        if (pickerActive) onDown();
        else historyNext();
        return;
      }
      if (pickerActive && key.pageUp) {
        onPageUp?.();
        return;
      }
      if (pickerActive && key.pageDown) {
        onPageDown?.();
        return;
      }
      if (pickerActive && termKey.tab) {
        onTabComplete?.();
        return;
      }
      if (termKey.escape) {
        onEscape();
        return;
      }

      if (!pickerActive && termKey.ctrl && (char === "o" || char === "O")) {
        onOpenAgentPicker?.();
        return;
      }

      if (termKey.return) {
        if (pickerActive) {
          onSubmit(value);
          return;
        }
        const trimmed = value.trim();
        if (trimmed) {
          onSubmit(trimmed);
          onChange("");
          setCursor(0);
          setHistoryIdx(history.length + 1);
          stashedRef.current = "";
          editSessionRef.current = createLineEditSession();
        }
        return;
      }

      if (termKey.meta && char === ".") {
        const lastLine = history[history.length - 1];
        if (lastLine) {
          const word = lastWordFromHistoryLine(lastLine);
          if (word) {
            const buf = { value, cursor };
            const next = insertText(buf, word);
            applyOutcome(next.value, next.cursor);
          }
        }
        return;
      }

      const outcome = applyLineEditKey({ value, cursor }, editSessionRef.current, char, termKey);

      if (outcome?.beginReverseSearch) {
        setRevSearch({ query: "", match: 0 });
        return;
      }

      if (outcome?.signal === "eof") {
        onSubmit("/ctrl-d");
        return;
      }
      if (outcome?.signal === "interrupt") {
        onSubmit("/stop-or-exit");
        return;
      }
      if (outcome?.signal === "clear-screen") {
        onSubmit("/clear");
        return;
      }

      if (outcome) {
        editSessionRef.current = outcome.session;
        applyOutcome(outcome.buffer.value, outcome.buffer.cursor);
        return;
      }
    },
    { isActive: !disabled },
  );

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? "";
  const after = value.slice(cursor + (at ? 1 : 0));

  return (
    <Box flexDirection="column" paddingX={1}>
      {revSearch ? (
        <Text dimColor>{`(reverse-i-search)\`${revSearch.query}': ${value}`}</Text>
      ) : null}
      <Box>
        <Text color={disabled ? "gray" : "green"} bold>
          {"❯ "}
        </Text>
        <Text>{before}</Text>
        {!disabled && (
          <Text color="green" inverse>
            {at || " "}
          </Text>
        )}
        <Text>{after}</Text>
        {pickerActive && <Text dimColor> ↑↓ PgUp/Dn · Tab · Enter · Esc</Text>}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// HRule (memoized)
// ---------------------------------------------------------------------------

const HRule = React.memo(function HRule({
  color = "gray",
}: { color?: string }): React.ReactElement {
  const cols = Math.max(20, getMarkdownLayoutWidth("full"));
  return <Text color={color}>{"─".repeat(cols)}</Text>;
});

// ---------------------------------------------------------------------------
// Quick greeting matcher
// ---------------------------------------------------------------------------

const GREETINGS: Array<[RegExp, string[]]> = [
  [
    /^(hi|hey|hello|howdy|yo|sup|hola|heya)\b/i,
    [
      "Hey! How can I help you today?",
      "Hello! What can I do for you?",
      "Hi there! Ready when you are.",
    ],
  ],
  [
    /^(how are you|how('s| is) it going|what'?s up)\??$/i,
    [
      "Doing great, thanks! What are you working on?",
      "All good here! What can I help with?",
      "Ready to go! What do you need?",
    ],
  ],
  [
    /^(good (morning|afternoon|evening))\b/i,
    ["Good day! What can I help with?", "Hello! What are we working on?"],
  ],
  [
    /^(thanks|thank you|thx|ty)\b/i,
    ["You're welcome! Anything else?", "Happy to help! Need anything else?"],
  ],
  [/^(bye|goodbye|see ya|cya|later)\b/i, ["See you! Type /exit when you're ready to close."]],
];

function matchGreeting(input: string): string | null {
  const trimmed = input.trim().replace(/[!.]+$/, "");
  for (const [pattern, responses] of GREETINGS) {
    if (pattern.test(trimmed)) {
      return responses[Math.floor(Math.random() * responses.length)]!;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main REPL
// ---------------------------------------------------------------------------

export function Repl({
  session,
  adapter,
  initialAgent,
  systemContext,
  serverUrl,
  onExit,
}: ReplProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  /** Live TTY width (SIGWINCH → stdout.resize); drives markdown/table layout. */
  const [terminalCols, setTerminalCols] = useState(() => {
    const c = stdout.columns;
    return typeof c === "number" && c >= 20 ? c : getTerminalWidth();
  });
  const [terminalRows, setTerminalRows] = useState(() => {
    const r = stdout.rows;
    return typeof r === "number" && r >= 10 ? r : 24;
  });

  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      const c = stdout.columns;
      if (typeof c === "number" && c >= 20) {
        setTerminalCols((prev) => (prev === c ? prev : c));
      }
      const r = stdout.rows;
      if (typeof r === "number" && r >= 10) {
        setTerminalRows((prev) => (prev === r ? prev : r));
      }
    };
    const onResize = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(sync, 120);
    };
    sync();
    stdout.on("resize", onResize);
    return () => {
      if (debounce) clearTimeout(debounce);
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // ── Static items: the ONLY thing that appears on screen ──
  const [staticItems, setStaticItems] = useState<StaticItem[]>([]);
  const staticKeyRef = useRef(0);
  const nextKey = () => staticKeyRef.current++;

  // Generation counter — remount Static after /clear only (not on SIGWINCH).
  const [generation, setGeneration] = useState(0);

  // ── History: for sending context to the agent ──
  const historyRef = useRef<HistoryEntry[]>([]);
  const conversationIdRef = useRef<string | undefined>(session.conversationId);
  const activeSessionRef = useRef<ChatSession>(session);
  const transcriptHydratedRef = useRef(false);
  const accumulatedRef = useRef(""); // full response text during streaming

  // ── Active adapter + agent — swappable via /agents ──
  const adapterRef = useRef<StreamAdapter>(adapter);
  const [currentAgent, setCurrentAgent] = useState<Agent>(initialAgent);

  // ── Input history: previous user inputs for Up/Down navigation ──
  const [inputHistory, setInputHistory] = useState<string[]>([]);

  // ── UI state ──
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [totalTokenDisplay, setTotalTokenDisplay] = useState(0);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  /** Full agent list while interactive /agents picker is open (filter text = `input`). */
  const [agentPickerCatalog, setAgentPickerCatalog] = useState<Agent[] | null>(null);
  const [agentPickerIndex, setAgentPickerIndex] = useState(0);
  const [sessionPickerCatalog, setSessionPickerCatalog] = useState<SessionSummary[] | null>(null);
  const [sessionPickerIndex, setSessionPickerIndex] = useState(0);
  const liveToolsRef = useRef<LiveToolRefEntry[]>([]);
  const [localShellRun, setLocalShellRun] = useState<{ cmd: string; startedAt: number } | null>(
    null,
  );
  const [localShellElapsed, setLocalShellElapsed] = useState(0);
  const [shellApproval, setShellApproval] = useState<ShellApprovalRequest | null>(null);
  const shellApprovalResolveRef = useRef<((approved: boolean) => void) | null>(null);
  const turnToolRunsRef = useRef<ToolActivityRun[]>([]);
  const toolArgsBufferRef = useRef<Map<string, string>>(new Map());
  const toolNameByCallIdRef = useRef<Map<string, string>>(new Map());
  const toolDiffSeenRef = useRef<Set<string>>(new Set());
  const pendingToolDiffsRef = useRef<string[]>([]);
  const tokenCountRef = useRef(0);
  const streamStartRef = useRef(0);
  const streamTokenRef = useRef(0);
  const streamPhaseRef = useRef<"thinking" | "generating">("generating");
  const toolRunsDetailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionStartRef = useRef(Date.now());
  const ctrlDCountRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingTokensRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Helpers to push items to the Static list ──
  // biome-ignore lint/correctness/useExhaustiveDependencies: nextKey is a stable ref-based counter, not a reactive dependency
  const pushStatic = useCallback((item: StaticItemInput) => {
    const _key = nextKey();
    setStaticItems((prev) => [...prev, { ...item, _key } as StaticItem]);
  }, []);

  const promptShellApproval = useCallback(
    (request: ShellApprovalRequest) =>
      new Promise<boolean>((resolve) => {
        shellApprovalResolveRef.current = resolve;
        setShellApproval(request);
      }),
    [],
  );

  const respondShellApproval = useCallback((approved: boolean) => {
    const resolve = shellApprovalResolveRef.current;
    shellApprovalResolveRef.current = null;
    setShellApproval(null);
    resolve?.(approved);
  }, []);

  const pushUser = useCallback(
    (text: string) => {
      pushStatic({ kind: "user", text });
      historyRef.current.push({ role: "user", content: text });
      // Add to input history for Up/Down navigation (dedup consecutive)
      setInputHistory((prev) => (prev[prev.length - 1] === text ? prev : [...prev, text]));
    },
    [pushStatic],
  );

  const pushAssistant = useCallback(
    (text: string) => {
      const { recap, body } = extractRecap(text);
      const displayBody = body.trim() ? body : text;
      if (recap) pushStatic({ kind: "recap", text: recap });
      pushStatic({ kind: "assistant", text: displayBody });
      historyRef.current.push({ role: "assistant", content: text });
    },
    [pushStatic],
  );

  /** System/slash output — no markdown parse (avoids Ink layout crashes). */
  const pushAssistantPlain = useCallback(
    (text: string) => {
      pushStatic({ kind: "assistant-plain", text });
      historyRef.current.push({ role: "assistant", content: text });
    },
    [pushStatic],
  );

  // Restore saved transcript when resuming a session (`caipe chat --resume <id>`).
  const applySessionTranscript = useCallback((loaded: ChatSession) => {
    const items: StaticItem[] = [];
    let key = 0;
    const history: HistoryEntry[] = [];
    for (const msg of loaded.messages) {
      if (msg.role === "user") {
        items.push({ kind: "user", text: msg.content, _key: key++ });
        history.push({ role: "user", content: msg.content });
      } else {
        const { recap, body } = extractRecap(msg.content);
        const displayBody = body.trim() ? body : msg.content;
        if (recap) items.push({ kind: "recap", text: recap, _key: key++ });
        items.push({ kind: "assistant", text: displayBody, _key: key++ });
        history.push({ role: "assistant", content: msg.content });
      }
    }
    staticKeyRef.current = key;
    setStaticItems(items);
    historyRef.current = history;
    const approxTokens = Math.ceil(loaded.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    tokenCountRef.current = approxTokens;
    setTotalTokenDisplay(approxTokens);
  }, []);

  const persistActiveSession = useCallback(() => {
    const snap = activeSessionRef.current;
    if (historyRef.current.length === 0) return;
    const messages = historyRef.current.map((m) => ({
      ...m,
      timestamp: new Date().toISOString(),
      agentName: currentAgent.name,
      tokenCount: null,
    }));
    saveSession({
      ...snap,
      agentName: currentAgent.name,
      messages,
      conversationId: conversationIdRef.current,
    });
  }, [currentAgent.name]);

  useEffect(() => {
    if (transcriptHydratedRef.current || session.messages.length === 0) return;
    transcriptHydratedRef.current = true;
    applySessionTranscript(session);
    const shortId = session.sessionId.slice(0, 8);
    pushAssistantPlain(
      `Resumed session ${shortId} · ${session.messages.length} message(s)${
        session.conversationId ? " · server thread linked" : ""
      }`,
    );
  }, [session, applySessionTranscript, pushAssistantPlain]);

  const recordCompletedToolRun = useCallback((r: LiveToolRefEntry, completedAt: number) => {
    turnToolRunsRef.current.push({
      name: r.name,
      detail: r.detail,
      durationSec: Math.max(0, Math.round((completedAt - r.startedAt) / 1000)),
    });
  }, []);

  const flushToolActivityStatic = useCallback(
    (elapsed: number) => {
      const now = Date.now();
      for (const r of liveToolsRef.current) {
        recordCompletedToolRun(r, now);
      }
      liveToolsRef.current = [];
      const all = turnToolRunsRef.current;
      if (all.length > 0) {
        const max = maxStaticToolTreeRows();
        const omitted = Math.max(0, all.length - max);
        const runs = omitted > 0 ? all.slice(-max) : all;
        pushStatic({
          kind: "tool-activity",
          elapsed,
          runs,
          omittedCount: omitted > 0 ? omitted : undefined,
        });
        turnToolRunsRef.current = [];
      }
      toolArgsBufferRef.current.clear();
    },
    [pushStatic, recordCompletedToolRun],
  );

  const startToolRun = useCallback(
    (name: string, toolCallId?: string) => {
      const now = Date.now();
      for (const r of liveToolsRef.current) {
        recordCompletedToolRun(r, now);
      }
      liveToolsRef.current = [{ name, toolCallId, startedAt: now }];
    },
    [recordCompletedToolRun],
  );

  const appendToolArgs = useCallback((toolCallId: string, delta: string) => {
    const prev = toolArgsBufferRef.current.get(toolCallId) ?? "";
    const next = prev + delta;
    toolArgsBufferRef.current.set(toolCallId, next);
    const cmd = commandFromToolArgsBuffer(next);
    if (!cmd) return;
    if (toolRunsDetailTimerRef.current) {
      clearTimeout(toolRunsDetailTimerRef.current);
    }
    toolRunsDetailTimerRef.current = setTimeout(() => {
      toolRunsDetailTimerRef.current = null;
      const live = liveToolsRef.current;
      const idx = live.findIndex((t) => t.toolCallId === toolCallId);
      if (idx >= 0 && live[idx]) {
        live[idx] = { ...live[idx], detail: cmd };
      }
    }, 400);
  }, []);

  const tryCaptureToolDiff = useCallback((toolCallId: string, resultContent?: string) => {
    if (toolDiffSeenRef.current.has(toolCallId)) return;
    const name = toolNameByCallIdRef.current.get(toolCallId) ?? "tool";
    const argsJson = toolArgsBufferRef.current.get(toolCallId);
    const patch = patchFromToolCall(name, argsJson, resultContent);
    if (!patch) return;
    toolDiffSeenRef.current.add(toolCallId);
    pendingToolDiffsRef.current.push(patch.unifiedDiff);
  }, []);

  const pushPendingToolDiffs = useCallback(() => {
    const diffs = pendingToolDiffsRef.current;
    if (diffs.length === 0) return;
    pendingToolDiffsRef.current = [];
    const text = diffs.length === 1 ? diffs[0]! : diffs.join("\n");
    pushStatic({ kind: "assistant-segment", text, diff: true, lead: false });
  }, [pushStatic]);

  const clearToolRuns = useCallback(
    (elapsed: number) => {
      flushToolActivityStatic(elapsed);
    },
    [flushToolActivityStatic],
  );

  const pushChunk = useCallback(
    (text: string) => {
      if (!text) return;
      pushStatic({ kind: "chunk", text });
    },
    [pushStatic],
  );

  const emitStreamDelta = useCallback(
    (text: string) => {
      if (!text) return;
      if (streamPlainTextEnabled()) {
        pushChunk(text);
      }
      // Default: accumulate only; markdown renders once when the turn completes.
    },
    [pushChunk],
  );

  const scheduleTokenFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      const text = pendingTokensRef.current;
      if (!text) return;
      pendingTokensRef.current = "";
      accumulatedRef.current += text;
      streamPhaseRef.current = "generating";
      streamTokenRef.current += Math.ceil(text.length / 4);
      emitStreamDelta(text);
    }, STREAM_TOKEN_BUFFER_MS);
  }, [emitStreamDelta]);

  const flushTokens = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const text = pendingTokensRef.current;
    if (text) {
      pendingTokensRef.current = "";
      accumulatedRef.current += text;
      streamPhaseRef.current = "generating";
      streamTokenRef.current += Math.ceil(text.length / 4);
      emitStreamDelta(text);
    }
  }, [emitStreamDelta]);

  const flushLineBuffer = useCallback(() => {
    const text = pendingTokensRef.current;
    if (text) {
      pendingTokensRef.current = "";
      accumulatedRef.current += text;
      emitStreamDelta(text);
    }
  }, [emitStreamDelta]);

  /** Rebuild Static from history (plain streaming); no viewport clear. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: nextKey is a stable ref-based counter
  const syncStaticFromHistory = useCallback(() => {
    staticKeyRef.current = 0;
    const items: StaticItem[] = [];
    for (const msg of historyRef.current) {
      const _key = nextKey();
      if (msg.role === "user") {
        items.push({ _key, kind: "user" as const, text: msg.content });
      } else {
        const { recap, body } = extractRecap(msg.content);
        const displayBody = body.trim() ? body : msg.content;
        if (recap) items.push({ _key: nextKey(), kind: "recap" as const, text: recap });
        items.push({ _key, kind: "assistant" as const, text: displayBody });
      }
    }
    setStaticItems(items);
  }, []);

  // ── Slash picker ──
  const filteredCommands = useMemo<SlashCommand[]>(() => {
    if (!input?.startsWith("/")) return [];
    const query = input.slice(1).toLowerCase().trim();
    if (query === "") return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter(
      (c) => c.name.slice(1).includes(query) || c.description.toLowerCase().includes(query),
    );
  }, [input]);

  const showPicker =
    !!input?.startsWith("/") &&
    !streaming &&
    agentPickerCatalog === null &&
    sessionPickerCatalog === null;

  const agentPickerActive = agentPickerCatalog !== null && !streaming;
  const sessionPickerActive = sessionPickerCatalog !== null && !streaming;
  const overlayPickerActive = agentPickerActive || sessionPickerActive;
  /** Keep picker + input on-screen without scrolling the alternate buffer. */
  const pickerVisibleRows = useMemo(() => {
    const reserved = 11;
    return Math.max(6, Math.min(12, terminalRows - reserved));
  }, [terminalRows]);
  const agentPickerFiltered = useMemo(() => {
    if (!agentPickerCatalog) return [];
    return filterAgents(agentPickerCatalog, input);
  }, [agentPickerCatalog, input]);

  const sessionPickerFiltered = useMemo(() => {
    if (!sessionPickerCatalog) return [];
    return filterSessions(sessionPickerCatalog, input);
  }, [sessionPickerCatalog, input]);

  useEffect(() => {
    if (!sessionPickerActive) return;
    setSessionPickerIndex((i) => clampPickerIndex(i, sessionPickerFiltered.length));
  }, [sessionPickerActive, sessionPickerFiltered.length]);

  useEffect(() => {
    if (!agentPickerActive) return;
    setAgentPickerIndex((i) => clampPickerIndex(i, agentPickerFiltered.length));
  }, [agentPickerActive, agentPickerFiltered.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `input` is an intentional reset trigger (not read in the body) so the slash-command selection jumps back to the top whenever the filter text changes, not only when the picker opens/closes.
  useEffect(() => {
    if (!showPicker) return;
    setPickerIndex(0);
  }, [input, showPicker]);

  useEffect(() => {
    if (!streaming) {
      streamTokenRef.current = 0;
      streamPhaseRef.current = "generating";
      return;
    }
    streamStartRef.current = Date.now();
    streamPhaseRef.current = "thinking";
  }, [streaming]);

  useEffect(() => {
    if (!localShellRun) {
      setLocalShellElapsed(0);
      return;
    }
    const id = setInterval(() => {
      setLocalShellElapsed(Math.floor((Date.now() - localShellRun.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [localShellRun]);

  // ── Exit ──
  const handleExit = useCallback(() => {
    const finishedMessages: {
      role: "user" | "assistant";
      content: string;
      timestamp: string;
      agentName: string;
      tokenCount: null;
    }[] = historyRef.current.map((m) => ({
      ...m,
      timestamp: new Date().toISOString(),
      agentName: currentAgent.name,
      tokenCount: null,
    }));

    const turns = historyRef.current.filter((m) => m.role === "user").length;
    const elapsedSec = Math.floor((Date.now() - sessionStartRef.current) / 1000);
    const mins = Math.floor(elapsedSec / 60);
    const secs = elapsedSec % 60;
    const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    const tokens = tokenCountRef.current;
    process.stdout.write(
      `\n  Session ended · ${turns} turn${turns !== 1 ? "s" : ""} · ~${tokens} tokens · ${duration}\n\n`,
    );

    onExit({
      ...activeSessionRef.current,
      agentName: currentAgent.name,
      messages: finishedMessages,
      conversationId: conversationIdRef.current,
    });
    exit();
  }, [onExit, exit, currentAgent.name]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset picker on filter count change, not on array identity
  useEffect(() => {
    setPickerIndex(0);
  }, [filteredCommands.length]);

  const switchToAgent = useCallback(
    (target: Agent) => {
      let sv: string;
      try {
        sv = getServerUrl();
      } catch {
        sv = serverUrl ?? "";
      }
      const authUrl2 = (() => {
        try {
          return getAuthUrl();
        } catch {
          return sv;
        }
      })();
      const ep = authEndpoints(sv);
      adapterRef.current = createAdapter(target, ep.streamStart, () => getValidToken(authUrl2));
      conversationIdRef.current = undefined;
      setCurrentAgent(target);
      pushAssistantPlain(`Switched to agent ${target.displayName ?? target.name}.`);
    },
    [serverUrl, pushAssistantPlain],
  );

  const resumeSessionById = useCallback(
    async (sessionId: string) => {
      if (streaming) {
        pushAssistantPlain("Stop the current turn before resuming another session.");
        return;
      }
      if (sessionId === activeSessionRef.current.sessionId) {
        pushAssistantPlain("Already on this session.");
        return;
      }
      const loaded = loadSession(sessionId);
      if (!loaded) {
        pushAssistantPlain(`Session file missing for ${sessionId}.`);
        return;
      }
      setStatusText("Resuming session…");
      try {
        persistActiveSession();
        process.stdout.write("\x1b[2J\x1b[H");
        setGeneration((g) => g + 1);
        applySessionTranscript(loaded);
        activeSessionRef.current = loaded;
        conversationIdRef.current = loaded.conversationId;
        transcriptHydratedRef.current = true;

        if (loaded.agentName !== currentAgent.name) {
          let sv = serverUrl ?? "";
          try {
            sv = getServerUrl();
          } catch {
            /* keep */
          }
          const authUrl2 = (() => {
            try {
              return getAuthUrl();
            } catch {
              return sv;
            }
          })();
          const agents = await fetchAgents(sv, () => getValidToken(authUrl2));
          const target = getAgent(agents, loaded.agentName);
          if (target) {
            switchToAgent(target);
            conversationIdRef.current = loaded.conversationId;
          } else {
            pushAssistantPlain(
              `Note: agent "${loaded.agentName}" is not available; staying on ${currentAgent.name}.`,
            );
          }
        }

        const shortId = loaded.sessionId.slice(0, 8);
        pushAssistantPlain(
          `Resumed session ${shortId} · ${loaded.messages.length} message(s)${
            loaded.conversationId ? " · server thread linked" : ""
          }`,
        );
      } catch (err) {
        pushAssistantPlain(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setStatusText(null);
      }
    },
    [
      streaming,
      pushAssistantPlain,
      persistActiveSession,
      applySessionTranscript,
      serverUrl,
      currentAgent.name,
      switchToAgent,
    ],
  );

  const openSessionPicker = useCallback(() => {
    if (streaming) return;
    setAgentPickerCatalog(null);
    const all = listSessions();
    if (all.length === 0) {
      pushAssistantPlain(
        "No saved sessions yet. End with /exit to persist, or run `caipe sessions list`.",
      );
      return;
    }
    setSessionPickerCatalog(all);
    setSessionPickerIndex(0);
    setInput("");
  }, [streaming, pushAssistantPlain]);

  const openAgentPicker = useCallback(async () => {
    if (streaming) return;
    setSessionPickerCatalog(null);
    setStatusText("Loading agents from registry…");
    try {
      let sv: string;
      try {
        sv = getServerUrl();
      } catch {
        sv = serverUrl ?? "";
      }
      const authUrl2 = (() => {
        try {
          return getAuthUrl();
        } catch {
          return sv;
        }
      })();
      const agents = await fetchAgents(sv, () => getValidToken(authUrl2));
      const sorted = sortAgentsForPicker(agents, currentAgent.name);
      const idx = Math.max(
        0,
        sorted.findIndex((a) => a.name === currentAgent.name),
      );
      setAgentPickerCatalog(sorted);
      setAgentPickerIndex(idx);
      setInput("");
    } catch (err) {
      pushAssistantPlain(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStatusText(null);
    }
  }, [streaming, serverUrl, currentAgent.name, pushAssistantPlain]);

  const openSlashPicker = useCallback(() => {
    if (streaming) return;
    setAgentPickerCatalog(null);
    setSessionPickerCatalog(null);
    setInput(SHORTCUT_SLASH_COMMANDS);
    setPickerIndex(0);
  }, [streaming]);

  // ── Slash commands ──
  const executeSlashCommand = useCallback(
    async (cmd: string) => {
      const base = cmd.split(" ")[0]?.toLowerCase() ?? "";

      switch (base) {
        case "/exit":
          handleExit();
          break;

        case "/stop-or-exit":
          if (streaming && abortControllerRef.current) {
            abortControllerRef.current.abort();
            setStreaming(false);
          } else {
            handleExit();
          }
          break;

        case "/ctrl-d":
          ctrlDCountRef.current += 1;
          if (ctrlDCountRef.current >= 2) {
            handleExit();
          } else {
            setStatusText("Press Ctrl+D again to exit.");
            setTimeout(() => {
              ctrlDCountRef.current = 0;
              setStatusText(null);
            }, 2000);
          }
          break;

        case "/clear":
          process.stdout.write("\x1b[2J\x1b[H");
          setStaticItems([]);
          staticKeyRef.current = 0;
          historyRef.current = [];
          tokenCountRef.current = 0;
          setTotalTokenDisplay(0);
          setGeneration((g) => g + 1);
          setStatusText("Context cleared.");
          setTimeout(() => setStatusText(null), 2000);
          break;

        case "/compact":
          setStatusText("Compacting history…");
          historyRef.current = historyRef.current.slice(-6);
          tokenCountRef.current = Math.floor(tokenCountRef.current * 0.3);
          setTotalTokenDisplay(tokenCountRef.current);
          setTimeout(() => setStatusText(null), 1500);
          break;

        case "/help":
          setInput("/");
          setPickerIndex(0);
          break;

        case "/skills":
          setStatusText("Loading skills from supervisor…");
          try {
            let skillsUrl: string;
            try {
              skillsUrl = getServerUrl();
            } catch {
              skillsUrl = serverUrl ?? "";
            }
            const skillsAuthUrl = (() => {
              try {
                return getAuthUrl();
              } catch {
                return skillsUrl;
              }
            })();
            const { skills, meta } = await fetchSupervisorSkills(
              () => getValidToken(skillsAuthUrl),
              skillsUrl,
            );
            if (skills.length === 0) {
              pushAssistant("No skills loaded in supervisor.");
            } else {
              const header = `**${meta.total} skills loaded** (sources: ${(meta.sources_loaded ?? []).join(", ") || "unknown"})\n\n`;
              const table = skills
                .map((s) => {
                  const tags = (s.metadata?.tags ?? []).join(", ");
                  return `- **${s.name}** — ${s.description || "(no description)"}${tags ? ` [${tags}]` : ""} _(${s.source})_`;
                })
                .join("\n");
              pushAssistant(header + table);
            }
          } catch (err) {
            pushAssistant(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            setStatusText(null);
          }
          break;

        case "/resume": {
          if (streaming) {
            pushAssistantPlain("Stop the current turn before resuming another session.");
            break;
          }
          const arg = cmd.slice("/resume".length).trim();
          if (!arg) {
            openSessionPicker();
            break;
          }
          const resolved = resolveSessionIdByArg(arg);
          if (!resolved.ok) {
            pushAssistantPlain(resolved.message);
            break;
          }
          await resumeSessionById(resolved.sessionId);
          break;
        }

        case "/agents": {
          const arg = cmd.split(" ")[1]?.trim();
          if (arg) {
            setStatusText("Loading agents from registry…");
            try {
              let sv: string;
              try {
                sv = getServerUrl();
              } catch {
                sv = serverUrl ?? "";
              }
              const authUrl2 = (() => {
                try {
                  return getAuthUrl();
                } catch {
                  return sv;
                }
              })();
              const agents = await fetchAgents(sv, () => getValidToken(authUrl2));
              const target = getAgent(agents, arg);
              if (!target) {
                pushAssistantPlain(
                  `Agent "${arg}" not found. Run /agents or ${SHORTCUT_AGENT_PICKER} to pick from the list.`,
                );
              } else {
                switchToAgent(target);
              }
            } catch (err) {
              pushAssistantPlain(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
            } finally {
              setStatusText(null);
            }
          } else {
            await openAgentPicker();
          }
          break;
        }

        case "/login":
          setStatusText("Opening browser for re-authentication…");
          try {
            let authUrl: string;
            try {
              authUrl = getAuthUrl();
            } catch {
              authUrl = serverUrl ?? "";
            }
            const tokens = await loginBrowser(authUrl, "caipe-cli");
            const who = tokens.email || tokens.displayName || tokens.identity || "(authenticated)";
            pushAssistant(`Re-authenticated as **${who}**.`);
          } catch (err) {
            pushAssistant(
              `[ERROR] Re-auth failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            setStatusText(null);
          }
          break;

        case "/memory": {
          const { memoryFilePaths } = await import("../memory/loader.js");
          const paths = memoryFilePaths(process.cwd());
          const editor = process.env.VISUAL ?? process.env.EDITOR;
          if (editor && paths.length > 0) {
            const target = paths[0]!;
            setStatusText(`Opening ${target} in ${editor}…`);
            try {
              const { spawnSync } = await import("node:child_process");
              spawnSync(editor, [target], { stdio: "inherit" });
            } catch {
              // ignore
            } finally {
              setStatusText(null);
            }
          } else {
            const listed =
              paths.length > 0 ? paths.map((p) => `- \`${p}\``).join("\n") : "_(none found)_";
            pushAssistant(
              `**Memory files** (loaded at session start):\n${listed}\n\nSet **EDITOR** to open inline, or edit files directly and restart the session.`,
            );
          }
          break;
        }

        case "/settings": {
          const s = readSettings();
          const path = settingsJsonPath();
          const editor = process.env.VISUAL ?? process.env.EDITOR;
          if (editor) {
            // Pause Ink, open editor, resume
            setStatusText(`Opening ${path} in ${editor}…`);
            try {
              const { spawnSync } = await import("node:child_process");
              spawnSync(editor, [path], { stdio: "inherit" });
            } catch {
              // ignore spawn errors
            } finally {
              setStatusText(null);
            }
          } else {
            // No editor — print current settings
            const lines = [
              `**Settings** — \`${path}\`\n`,
              `- **server.url** = \`${s.server?.url ?? "(not set)"}\``,
              `- **auth.url** = \`${s.auth?.url ?? "(not set)"}\``,
              `- **auth.idp-hint** = \`${s.auth?.idpHint ?? "(not set)"}\``,
              `- **auth.credential-storage** = \`${s.auth?.credentialStorage ?? "encrypted-file"}\``,
              `- **updates.mode** = \`${s.updates?.mode ?? "notify"}\``,
              "\nTo edit, set **EDITOR** or run `caipe config set <key> <value>`",
            ];
            pushAssistant(lines.join("\n"));
          }
          break;
        }

        default:
          pushAssistant(`Unknown command: ${cmd}. Type / to see available commands.`);
      }
    },
    [
      handleExit,
      pushAssistant,
      pushAssistantPlain,
      streaming,
      serverUrl,
      switchToAgent,
      openAgentPicker,
      openSessionPicker,
      resumeSessionById,
    ],
  );

  // ── Submit: greeting / shell escape / pipe / agent prompt ──
  const handleSubmit = useCallback(
    async (text: string) => {
      if (text.startsWith("/")) {
        await executeSlashCommand(text);
        return;
      }

      // Quick local greetings
      const greeting = matchGreeting(text);
      if (greeting) {
        setStatusText(greeting);
        setTimeout(() => setStatusText(null), 3000);
        return;
      }

      const parsed = parseInput(text);

      // ── Shell escape: ! <cmd> ──
      if (parsed.shellCmd) {
        pushUser(text);
        if (isShellHitlEnabled()) {
          const approved = await promptShellApproval({
            cmd: parsed.shellCmd,
            kind: "escape",
          });
          if (!approved) {
            pushAssistantPlain("Shell command cancelled.");
            return;
          }
        }
        const startedAt = Date.now();
        setLocalShellRun({ cmd: parsed.shellCmd, startedAt });
        try {
          const { stdout, stderr, exitCode } = await runShellCommand(parsed.shellCmd);
          const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
          pushStatic({
            kind: "tool-activity",
            elapsed,
            runs: [{ name: "shell", detail: parsed.shellCmd, durationSec: elapsed }],
          });
          const output = (stdout + (stderr ? `\n[stderr] ${stderr}` : "")).trim();
          pushAssistant(
            output
              ? `\`\`\`\n${output}\n\`\`\`${exitCode !== 0 ? `\n_(exit code ${exitCode})_` : ""}`
              : `_(no output, exit code ${exitCode})_`,
          );
        } catch (err) {
          pushAssistant(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          setLocalShellRun(null);
          setStatusText(null);
        }
        return;
      }

      // ── Agent prompt (with optional pipe) ──
      const prompt = parsed.prompt;
      pushUser(text);
      tokenCountRef.current += Math.ceil(prompt.length / 4);
      setTotalTokenDisplay(tokenCountRef.current);

      // Start streaming — block markdown in dynamic area (default)
      accumulatedRef.current = "";
      turnToolRunsRef.current = [];
      toolArgsBufferRef.current.clear();
      toolNameByCallIdRef.current.clear();
      toolDiffSeenRef.current.clear();
      pendingToolDiffsRef.current = [];
      liveToolsRef.current = [];
      setStreaming(true);
      if (streamPlainTextEnabled()) {
        pushStatic({ kind: "chunk", text: "" });
      }

      try {
        const gen = adapterRef.current.connect({
          prompt,
          systemContext,
          sessionId: activeSessionRef.current.sessionId,
          conversationId: conversationIdRef.current,
          agentName: currentAgent.name,
          history: historyRef.current,
        });

        for await (const ev of gen) {
          if (ev.type === "conversation") {
            conversationIdRef.current = ev.conversationId;
            patchSessionConversationId(activeSessionRef.current.sessionId, ev.conversationId);
          } else if (ev.type === "token") {
            pendingTokensRef.current += ev.text;
            scheduleTokenFlush();
          } else if (ev.type === "tool") {
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            flushTokens();
            if (ev.toolCallId) toolNameByCallIdRef.current.set(ev.toolCallId, ev.name);
            startToolRun(ev.name, ev.toolCallId);
          } else if (ev.type === "tool-args") {
            appendToolArgs(ev.toolCallId, ev.delta);
          } else if (ev.type === "tool-end") {
            tryCaptureToolDiff(ev.toolCallId);
          } else if (ev.type === "tool-result") {
            tryCaptureToolDiff(ev.toolCallId, ev.content);
          } else if (ev.type === "interrupted") {
            flushTokens();
            flushLineBuffer();
            break;
          } else if (ev.type === "error") {
            pushAssistant(`[ERROR] ${ev.message}`);
            break;
          } else if (ev.type === "done") {
            break;
          }
        }

        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        flushTokens();
        flushLineBuffer();

        let finalContent = accumulatedRef.current;
        if (parsed.pipeCmd && finalContent) {
          let pipeApproved = true;
          if (isShellHitlEnabled()) {
            pipeApproved = await promptShellApproval({ cmd: parsed.pipeCmd, kind: "pipe" });
          }
          if (pipeApproved) {
            setStatusText(`Piping through: ${parsed.pipeCmd}`);
            finalContent = await pipeThrough(finalContent, parsed.pipeCmd);
          }
        }
        if (finalContent) {
          tokenCountRef.current += Math.ceil(finalContent.length / 4);
          setTotalTokenDisplay(tokenCountRef.current);
        }

        if (streamPlainTextEnabled()) {
          syncStaticFromHistory();
        } else {
          const turnElapsed = Math.max(0, Math.floor((Date.now() - streamStartRef.current) / 1000));
          clearToolRuns(turnElapsed);
          pushPendingToolDiffs();
          if (finalContent) {
            pushAssistant(finalContent);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushAssistant(`[ERROR] ${msg}`);
      } finally {
        pendingTokensRef.current = "";
        if (streamPlainTextEnabled()) {
          const turnElapsed = Math.max(0, Math.floor((Date.now() - streamStartRef.current) / 1000));
          clearToolRuns(turnElapsed);
        }
        setStreaming(false);
        setStatusText(null);
      }
    },
    [
      systemContext,
      currentAgent,
      executeSlashCommand,
      flushTokens,
      flushLineBuffer,
      scheduleTokenFlush,
      pushUser,
      pushAssistant,
      pushAssistantPlain,
      promptShellApproval,
      pushStatic,
      appendToolArgs,
      tryCaptureToolDiff,
      pushPendingToolDiffs,
      startToolRun,
      clearToolRuns,
      syncStaticFromHistory,
    ],
  );

  // ── Picker navigation ──
  const handlePickerSubmit = useCallback(
    (raw: string) => {
      if (sessionPickerActive && sessionPickerFiltered.length > 0) {
        const target = sessionPickerFiltered[sessionPickerIndex];
        if (target) {
          setSessionPickerCatalog(null);
          setInput("");
          void resumeSessionById(target.sessionId);
        }
        return;
      }
      if (agentPickerActive && agentPickerFiltered.length > 0) {
        const target = agentPickerFiltered[agentPickerIndex];
        if (target) switchToAgent(target);
        setAgentPickerCatalog(null);
        setInput("");
        return;
      }
      if (showPicker && filteredCommands.length > 0) {
        const selected = filteredCommands[clampPickerIndex(pickerIndex, filteredCommands.length)];
        if (selected) {
          void executeSlashCommand(selected.name);
          setInput("");
          setPickerIndex(0);
          return;
        }
      }
      void handleSubmit(raw);
    },
    [
      sessionPickerActive,
      sessionPickerFiltered,
      sessionPickerIndex,
      resumeSessionById,
      agentPickerActive,
      agentPickerFiltered,
      agentPickerIndex,
      switchToAgent,
      showPicker,
      filteredCommands,
      pickerIndex,
      executeSlashCommand,
      handleSubmit,
    ],
  );

  const handleUp = useCallback(() => {
    if (sessionPickerActive && sessionPickerFiltered.length > 0) {
      setSessionPickerIndex((i) => movePickerIndex(i, sessionPickerFiltered.length, -1));
      return;
    }
    if (agentPickerActive && agentPickerFiltered.length > 0) {
      setAgentPickerIndex((i) => movePickerIndex(i, agentPickerFiltered.length, -1));
      return;
    }
    if (!showPicker || filteredCommands.length === 0) return;
    setPickerIndex((i) => movePickerIndex(i, filteredCommands.length, -1));
  }, [
    sessionPickerActive,
    sessionPickerFiltered.length,
    agentPickerActive,
    agentPickerFiltered.length,
    showPicker,
    filteredCommands.length,
  ]);

  const handleDown = useCallback(() => {
    if (sessionPickerActive && sessionPickerFiltered.length > 0) {
      setSessionPickerIndex((i) => movePickerIndex(i, sessionPickerFiltered.length, 1));
      return;
    }
    if (agentPickerActive && agentPickerFiltered.length > 0) {
      setAgentPickerIndex((i) => movePickerIndex(i, agentPickerFiltered.length, 1));
      return;
    }
    if (!showPicker || filteredCommands.length === 0) return;
    setPickerIndex((i) => movePickerIndex(i, filteredCommands.length, 1));
  }, [
    sessionPickerActive,
    sessionPickerFiltered.length,
    agentPickerActive,
    agentPickerFiltered.length,
    showPicker,
    filteredCommands.length,
  ]);

  const handlePageUp = useCallback(() => {
    if (sessionPickerActive && sessionPickerFiltered.length > 0) {
      setSessionPickerIndex((i) =>
        pagePickerIndex(i, sessionPickerFiltered.length, PICKER_PAGE_JUMP, -1),
      );
      return;
    }
    if (agentPickerActive && agentPickerFiltered.length > 0) {
      setAgentPickerIndex((i) =>
        pagePickerIndex(i, agentPickerFiltered.length, PICKER_PAGE_JUMP, -1),
      );
      return;
    }
    if (!showPicker || filteredCommands.length === 0) return;
    setPickerIndex((i) => pagePickerIndex(i, filteredCommands.length, PICKER_PAGE_JUMP, -1));
  }, [
    sessionPickerActive,
    sessionPickerFiltered.length,
    agentPickerActive,
    agentPickerFiltered.length,
    showPicker,
    filteredCommands.length,
  ]);

  const handlePageDown = useCallback(() => {
    if (sessionPickerActive && sessionPickerFiltered.length > 0) {
      setSessionPickerIndex((i) =>
        pagePickerIndex(i, sessionPickerFiltered.length, PICKER_PAGE_JUMP, 1),
      );
      return;
    }
    if (agentPickerActive && agentPickerFiltered.length > 0) {
      setAgentPickerIndex((i) =>
        pagePickerIndex(i, agentPickerFiltered.length, PICKER_PAGE_JUMP, 1),
      );
      return;
    }
    if (!showPicker || filteredCommands.length === 0) return;
    setPickerIndex((i) => pagePickerIndex(i, filteredCommands.length, PICKER_PAGE_JUMP, 1));
  }, [
    sessionPickerActive,
    sessionPickerFiltered.length,
    agentPickerActive,
    agentPickerFiltered.length,
    showPicker,
    filteredCommands.length,
  ]);

  const handleTabComplete = useCallback(() => {
    if (sessionPickerActive && sessionPickerFiltered.length > 0) {
      const s =
        sessionPickerFiltered[clampPickerIndex(sessionPickerIndex, sessionPickerFiltered.length)];
      if (s) setInput(s.sessionId);
      return;
    }
    if (agentPickerActive && agentPickerFiltered.length > 0) {
      const agent =
        agentPickerFiltered[clampPickerIndex(agentPickerIndex, agentPickerFiltered.length)];
      if (agent) setInput(agent.name);
      return;
    }
    if (showPicker && filteredCommands.length > 0) {
      const cmd = filteredCommands[clampPickerIndex(pickerIndex, filteredCommands.length)];
      if (cmd) setInput(cmd.name);
    }
  }, [
    sessionPickerActive,
    sessionPickerFiltered,
    sessionPickerIndex,
    agentPickerActive,
    agentPickerFiltered,
    agentPickerIndex,
    showPicker,
    filteredCommands,
    pickerIndex,
  ]);

  const handleEscape = useCallback(() => {
    if (sessionPickerActive) {
      setSessionPickerCatalog(null);
      setInput("");
      return;
    }
    if (agentPickerActive) {
      setAgentPickerCatalog(null);
      setInput("");
      return;
    }
    if (showPicker) {
      setInput("");
      return;
    }
    if (streaming && abortControllerRef.current) {
      abortControllerRef.current.abort();
      setStreaming(false);
    } else {
      setInput("");
    }
  }, [sessionPickerActive, agentPickerActive, showPicker, streaming]);

  // ── Render ──

  const serverHost = serverUrl
    ? serverUrl
        .replace(/^https?:\/\//, "")
        .replace(/:443$/, "")
        .replace(/:80$/, "")
    : null;

  const markdownWidth = getMarkdownLayoutWidth("assistant", terminalCols);
  const terminalWidth = terminalCols;

  return (
    <Box flexDirection="column" height="100%">
      {overlayPickerActive ? (
        <Box paddingX={1} marginBottom={1}>
          <Text dimColor>Chat hidden while picker is open · Esc to return</Text>
        </Box>
      ) : (
        <StaticHistory
          generation={generation}
          items={staticItems}
          markdownWidth={markdownWidth}
          terminalWidth={terminalWidth}
        />
      )}

      <Box flexDirection="column" paddingY={0}>
        {!overlayPickerActive && localShellRun ? (
          <ToolActivityPanel
            phase="running"
            runs={[{ name: "shell", detail: localShellRun.cmd }]}
            elapsed={localShellElapsed}
          />
        ) : null}
        {!overlayPickerActive ? (
          <StreamingStatusPanel
            active={streaming}
            liveToolsRef={liveToolsRef}
            turnToolRunsRef={turnToolRunsRef}
            streamStartRef={streamStartRef}
            streamTokenRef={streamTokenRef}
            streamPhaseRef={streamPhaseRef}
          />
        ) : null}
        {staticItems.length === 0 && !streaming && !localShellRun && !overlayPickerActive && (
          <Box paddingX={1}>
            <Text dimColor>
              {`Type a message, ${SHORTCUT_SLASH_COMMANDS} for commands, or ${SHORTCUT_AGENT_PICKER} for agents.`}
            </Text>
          </Box>
        )}
      </Box>

      {shellApproval ? (
        <ShellApprovalPrompt
          request={shellApproval}
          onApprove={() => respondShellApproval(true)}
          onDeny={() => respondShellApproval(false)}
        />
      ) : null}

      {showPicker && (
        <SlashPicker input={input} selectedIndex={pickerIndex} filtered={filteredCommands} />
      )}

      {agentPickerActive && (
        <AgentPicker
          agents={agentPickerFiltered}
          selectedIndex={agentPickerIndex}
          activeAgentName={currentAgent.name}
          filter={input}
          visibleRowCount={pickerVisibleRows}
        />
      )}

      {sessionPickerActive && (
        <SessionPicker
          sessions={sessionPickerFiltered}
          selectedIndex={sessionPickerIndex}
          activeSessionId={activeSessionRef.current.sessionId}
          filter={input}
          visibleRowCount={pickerVisibleRows}
        />
      )}

      <HRule />

      <InputBar
        value={input}
        onChange={setInput}
        onSubmit={handlePickerSubmit}
        onUp={handleUp}
        onDown={handleDown}
        onPageUp={handlePageUp}
        onPageDown={handlePageDown}
        onTabComplete={handleTabComplete}
        onEscape={handleEscape}
        onOpenAgentPicker={openAgentPicker}
        onOpenSlashPicker={openSlashPicker}
        pickerNav={
          sessionPickerActive
            ? "session"
            : agentPickerActive
              ? "agent"
              : showPicker
                ? "slash"
                : "none"
        }
        disabled={streaming || shellApproval !== null}
        history={inputHistory}
      />

      <HRule />

      <Box paddingX={2} justifyContent="space-between">
        <Box flexDirection="column">
          {streaming ? (
            <Text dimColor>Esc cancel · Ctrl+C stop</Text>
          ) : statusText !== null ? (
            <Text dimColor>{statusText}</Text>
          ) : (
            <Text dimColor>{FOOTER_HINT_IDLE}</Text>
          )}
        </Box>
        <Text dimColor>
          {currentAgent.name !== "hello-world" && currentAgent.name !== "default"
            ? `${currentAgent.name} · `
            : ""}
          {totalTokenDisplay > 0 ? `~${totalTokenDisplay} tokens · ` : ""}
          {serverHost ?? ""}
        </Text>
      </Box>
    </Box>
  );
}
