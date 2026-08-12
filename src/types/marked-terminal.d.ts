/**
 * marked-terminal v7 ships no type declarations. Minimal ambient types for the
 * subset used by {@link ../platform/terminal/ansi-markdown.ts}.
 */
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  export interface MarkedTerminalOptions {
    width?: number;
    reflowText?: boolean;
    showSectionPrefix?: boolean;
    tab?: number;
    unescape?: boolean;
    emoji?: boolean;
    tableOptions?: Record<string, unknown>;
    [style: string]: unknown;
  }

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;
}
