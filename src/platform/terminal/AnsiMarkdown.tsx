import { Text } from "ink";
import type React from "react";
import { useMemo } from "react";

import { renderMarkdownToAnsi } from "./ansi-markdown.js";
import { getTerminalCapabilities } from "./capabilities.js";

export interface AnsiMarkdownProps {
  children: string;
  width?: number;
}

/** One-shot markdown display: pre-rendered ANSI in Ink (no react-markdown / flex tables). */
export function AnsiMarkdown({ children, width }: AnsiMarkdownProps): React.ReactElement {
  const caps = getTerminalCapabilities();
  const ansi = useMemo(
    () =>
      renderMarkdownToAnsi(children, {
        width: width ?? caps.width,
      }),
    [children, width, caps.width],
  );

  return <Text>{ansi}</Text>;
}
