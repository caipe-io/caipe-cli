import { Box } from "ink";
import type React from "react";
import { useMemo } from "react";

import { isUnifiedDiffText } from "../diff.js";
import { AnsiMarkdown } from "./AnsiMarkdown.js";
import { splitAssistantSegments } from "./assistant-segments.js";
import { InkDiffBlock } from "./ink-diff.js";

export interface AssistantBodyProps {
  text: string;
  width: number;
}

export function AssistantBody({ text, width }: AssistantBodyProps): React.ReactElement {
  const segments = useMemo(() => splitAssistantSegments(text), [text]);

  if (segments.length === 1 && segments[0]?.kind === "diff") {
    return <InkDiffBlock text={segments[0].text} width={width} />;
  }

  if (segments.length === 1 && segments[0]?.kind === "markdown" && isUnifiedDiffText(text.trim())) {
    return <InkDiffBlock text={text.trim()} width={width} />;
  }

  return (
    <Box flexDirection="column">
      {segments.map((seg, index) =>
        seg.kind === "diff" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a fixed re-parse of one message's text, never reordered or spliced.
          <InkDiffBlock key={`d-${index}`} text={seg.text} width={width} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a fixed re-parse of one message's text, never reordered or spliced.
          <AnsiMarkdown key={`m-${index}`} width={width}>
            {seg.text}
          </AnsiMarkdown>
        ),
      )}
    </Box>
  );
}
