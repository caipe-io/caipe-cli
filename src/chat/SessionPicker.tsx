/**
 * Interactive session picker for `/resume` in the chat REPL.
 */

import { Box, Text } from "ink";
import type React from "react";

import { PICKER_HINT_NAV } from "./shortcuts.js";
import { pickerWindow } from "./picker-nav.js";
import type { SessionSummary } from "./history.js";

const ROW_SEPARATOR = "  ────────────────────────────────────────────────────────";

function formatStarted(iso: string): string {
  return iso.slice(0, 19).replace("T", " ");
}

function shortSessionId(id: string): string {
  if (id.length <= 20) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

export interface SessionPickerProps {
  sessions: SessionSummary[];
  selectedIndex: number;
  activeSessionId: string;
  filter: string;
  visibleRowCount?: number;
}

export function SessionPicker({
  sessions,
  selectedIndex,
  activeSessionId,
  filter,
  visibleRowCount = 10,
}: SessionPickerProps): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" marginX={1} paddingX={1}>
        <Text dimColor>No sessions match {filter ? `"${filter}"` : "filter"}.</Text>
      </Box>
    );
  }

  const safeIndex = Math.max(0, Math.min(selectedIndex, sessions.length - 1));
  const selected = sessions[safeIndex];
  const { start, end } = pickerWindow(sessions.length, safeIndex, visibleRowCount);
  const slice = sessions.slice(start, end);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" marginX={1} paddingX={1}>
      <Box marginBottom={0}>
        <Text bold color="cyan">
          Resume session
        </Text>
        <Text dimColor>
          {` · ${PICKER_HINT_NAV}`}
          {filter ? ` · filter: "${filter}"` : " · type to filter"}
        </Text>
      </Box>
      {start > 0 ? <Text dimColor>{`  ↑ ${start} more above`}</Text> : null}
      {slice.map((s, i) => {
        const idx = start + i;
        const sel = idx === safeIndex;
        const inSession = s.sessionId === activeSessionId;
        const started = formatStarted(s.startedAt);
        const num = String(idx + 1).padStart(2, " ");
        return (
          <Box key={s.sessionId} flexDirection="column">
            {i > 0 ? <Text dimColor>{ROW_SEPARATOR}</Text> : null}
            <Box flexDirection="column">
              <Box>
                <Text bold={sel} color={sel ? "cyan" : undefined} dimColor={!sel}>
                  {`${num} `}
                </Text>
                <Text color={sel ? "cyan" : undefined}>{sel ? "▶ " : "  "}</Text>
                <Text bold={sel} color={sel ? "cyan" : "white"}>
                  {shortSessionId(s.sessionId).padEnd(22)}
                </Text>
                <Text dimColor={!sel}> {s.agentName.padEnd(28).slice(0, 28)} </Text>
                <Text dimColor={!sel}>
                  {s.messageCount} msg · {started}
                </Text>
                {inSession ? <Text dimColor={!sel}> · in session</Text> : null}
              </Box>
              {sel ? (
                <Box paddingLeft={4}>
                  <Text dimColor wrap="truncate">
                    {s.sessionId}
                  </Text>
                </Box>
              ) : null}
            </Box>
          </Box>
        );
      })}
      {end < sessions.length ? (
        <Text dimColor>{`  ↓ ${sessions.length - end} more below`}</Text>
      ) : null}
      <Box marginTop={0}>
        <Text color="cyan" bold>
          {`${safeIndex + 1}/${sessions.length}`}
        </Text>
        <Text dimColor> · </Text>
        <Text bold color="white">
          {selected ? shortSessionId(selected.sessionId) : ""}
        </Text>
        <Text dimColor> · Enter resume · Esc dismiss</Text>
      </Box>
    </Box>
  );
}
