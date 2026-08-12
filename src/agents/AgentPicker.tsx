/**
 * Interactive agent picker for the chat REPL (/agents).
 */

import { Box, Text } from "ink";
import type React from "react";

import { PICKER_HINT_NAV } from "../chat/shortcuts.js";
import { isRichTerminalEnabled } from "../platform/terminal/capabilities.js";
import { pickerWindow, truncateText } from "./picker.js";
import type { Agent } from "./types.js";

const DESC_SELECTED_MAX = 240;
const ROW_SEPARATOR = "  ────────────────────────────────────────────────────────";

function agentTitle(agent: Agent): string {
  const display = agent.displayName.trim();
  return display.length > 0 ? display : agent.name;
}

export interface AgentPickerProps {
  agents: Agent[];
  selectedIndex: number;
  activeAgentName: string;
  filter: string;
  /** Max agent rows in the scroll window (fits terminal). */
  visibleRowCount?: number;
}

export function AgentPicker({
  agents,
  selectedIndex,
  activeAgentName,
  filter,
  visibleRowCount = 8,
}: AgentPickerProps): React.ReactElement {
  if (agents.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" marginX={1} paddingX={1}>
        <Text dimColor>No agents match {filter ? `"${filter}"` : "filter"}.</Text>
      </Box>
    );
  }

  const rich = isRichTerminalEnabled();
  const safeIndex = Math.max(0, Math.min(selectedIndex, agents.length - 1));
  const selectedAgent = agents[safeIndex];
  const { start, end } = pickerWindow(agents.length, safeIndex, visibleRowCount);
  const slice = agents.slice(start, end);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" marginX={1} paddingX={1}>
      <Box marginBottom={0}>
        <Text bold color="cyan">
          Select agent
        </Text>
        <Text dimColor>
          {` · ${PICKER_HINT_NAV}`}
          {filter ? ` · filter: "${filter}"` : " · type to filter"}
        </Text>
      </Box>
      {start > 0 ? (
        <Text dimColor>{`  ↑ ${start} more above`}</Text>
      ) : null}
      {slice.map((agent, i) => {
        const idx = start + i;
        const selected = idx === safeIndex;
        const inSession = agent.name === activeAgentName;
        const title = agentTitle(agent);
        const desc = agent.description.trim();
        const descLine = selected ? truncateText(desc, DESC_SELECTED_MAX) : "";
        const num = String(idx + 1).padStart(2, " ");

        const rowBg = selected && rich ? "blue" : undefined;
        const titleColor = selected ? (rich ? "white" : "cyan") : undefined;
        const titleDim = !selected;

        return (
          <Box key={agent.name} flexDirection="column">
            {i > 0 ? <Text dimColor>{ROW_SEPARATOR}</Text> : null}
            <Box backgroundColor={rowBg} flexDirection="column">
              <Box>
                <Text bold={selected} color={selected ? "cyan" : undefined} dimColor={!selected}>
                  {`${num} `}
                </Text>
                <Text bold={selected} color={titleColor} dimColor={titleDim && !rich}>
                  {selected ? "▶ " : "  "}
                </Text>
                <Text bold={selected} color={titleColor} dimColor={titleDim && !rich} wrap="truncate">
                  {title}
                </Text>
                {inSession ? (
                  <Text
                    bold={selected}
                    color={selected && rich ? "white" : undefined}
                    dimColor={!selected || !rich}
                  >
                    {" · in session"}
                  </Text>
                ) : null}
              </Box>
              {selected && descLine ? (
                <>
                  <Box paddingLeft={2}>
                    <Text color={rich ? "white" : "cyan"} dimColor={!rich} wrap="truncate">
                      {`ID: ${agent.name}`}
                    </Text>
                  </Box>
                  <Box paddingLeft={2}>
                    <Text color={rich ? "white" : undefined} dimColor={!rich} wrap="wrap">
                      {descLine}
                    </Text>
                  </Box>
                </>
              ) : null}
            </Box>
          </Box>
        );
      })}
      {end < agents.length ? (
        <Text dimColor>{`  ↓ ${agents.length - end} more below`}</Text>
      ) : null}
      <Box marginTop={0}>
        <Text color="cyan" bold>
          {`${safeIndex + 1}/${agents.length}`}
        </Text>
        <Text dimColor> · </Text>
        <Text bold color="white">
          {selectedAgent ? agentTitle(selectedAgent) : ""}
        </Text>
        <Text dimColor>
          {` · Enter switch · ${agents.length} total · or /agents <id>`}
        </Text>
      </Box>
    </Box>
  );
}
