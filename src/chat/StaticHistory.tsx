/**
 * Frozen transcript — memoized so streaming timer ticks do not re-render Ink Static.
 */

import { Box, Static, Text } from "ink";
import type React from "react";
import { memo } from "react";

import {
  RecapLine,
  ToolActivityPanel,
  type ToolActivityRun,
  UserMessageBar,
} from "../platform/display.js";
import { AssistantBody, InkDiffBlock } from "../platform/markdown.js";
import { isDiffBlock } from "./markdown-stream.js";

export type StaticHistoryItem =
  | ({ kind: "user"; text: string } & { _key: number })
  | ({ kind: "recap"; text: string } & { _key: number })
  | ({ kind: "assistant"; text: string } & { _key: number })
  | ({ kind: "assistant-plain"; text: string } & { _key: number })
  | ({ kind: "assistant-segment"; text: string; diff?: boolean; lead?: boolean } & { _key: number })
  | ({ kind: "chunk"; text: string } & { _key: number })
  | ({ kind: "tool-activity"; elapsed: number; runs: ToolActivityRun[]; omittedCount?: number } & {
      _key: number;
    })
  | ({ kind: "tool"; name: string } & { _key: number });

export interface StaticHistoryProps {
  generation: number;
  items: StaticHistoryItem[];
  markdownWidth: number;
  terminalWidth: number;
}

function renderBody(text: string, width: number, diff?: boolean) {
  return (diff ?? isDiffBlock(text)) ? (
    <InkDiffBlock text={text} width={width} />
  ) : (
    <AssistantBody text={text} width={width} />
  );
}

function StaticHistoryInner({
  generation,
  items,
  markdownWidth,
  terminalWidth,
}: StaticHistoryProps): React.ReactElement {
  return (
    <Static key={generation} items={items}>
      {(item) => {
        switch (item.kind) {
          case "user":
            return <UserMessageBar key={item._key} text={item.text} width={terminalWidth} />;
          case "recap":
            return <RecapLine key={item._key} text={item.text} />;
          case "assistant":
            return (
              <Box key={item._key} paddingX={1} marginBottom={1} flexDirection="column">
                <Text color="blue">{"⏺ "}</Text>
                <Box paddingLeft={2} flexDirection="column">
                  {renderBody(item.text, markdownWidth)}
                </Box>
              </Box>
            );
          case "assistant-plain":
            return (
              <Box key={item._key} paddingX={1} marginBottom={1} flexDirection="row">
                <Text color="blue">{"⏺ "}</Text>
                <Text wrap="wrap">{item.text}</Text>
              </Box>
            );
          case "assistant-segment":
            return (
              <Box key={item._key} paddingX={1} flexDirection="row">
                <Text color="blue">{item.lead ? "⏺ " : "  "}</Text>
                {renderBody(item.text, markdownWidth, item.diff)}
              </Box>
            );
          case "chunk":
            return item.text ? (
              <Text key={item._key}>{item.text}</Text>
            ) : (
              <Box key={item._key} paddingX={1}>
                <Text color="blue">{"⏺ "}</Text>
              </Box>
            );
          case "tool-activity":
            return (
              <ToolActivityPanel
                key={item._key}
                phase="done"
                runs={item.runs}
                elapsed={item.elapsed}
                omittedCount={item.omittedCount ?? 0}
              />
            );
          case "tool":
            return (
              <Box key={item._key} paddingX={1} marginLeft={2}>
                <Text color="green">
                  {"✓ "}
                  {item.name}
                </Text>
              </Box>
            );
        }
      }}
    </Static>
  );
}

export const StaticHistory = memo(
  StaticHistoryInner,
  (prev, next) =>
    prev.generation === next.generation &&
    prev.items === next.items &&
    prev.markdownWidth === next.markdownWidth &&
    prev.terminalWidth === next.terminalWidth,
);
