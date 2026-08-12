/**
 * marked-terminal list renderer + marked v15: list items keep raw `**` because
 * inline tokens live under a nested `text` token. Override `list` only.
 */

import type { MarkedExtension, Parser, Token, Tokens } from "marked";

function listItemInlineText(parser: Parser, item: Tokens.ListItem): string {
  const parts: Token[] = item.tokens ?? [];
  if (parts.length === 0) return "";

  if (item.loose) {
    return parser.parse(parts).trimEnd();
  }

  if (parts.length === 1) {
    const head = parts[0];
    if (head?.type === "paragraph" && head.tokens?.length) {
      return parser.parseInline(head.tokens).trim();
    }
    if (head?.type === "text" && head.tokens?.length) {
      return parser.parseInline(head.tokens).trim();
    }
  }

  return parser.parseInline(parts).trim();
}

export function markedListInlineExtension(): MarkedExtension {
  return {
    renderer: {
      list(token: Tokens.List) {
        let index = token.start ? Number(token.start) : 1;
        const lines = token.items.map((item) => {
          const content = listItemInlineText(this.parser, item);
          const prefix = token.ordered ? `${index++}. ` : "• ";
          return prefix + content;
        });
        return `${lines.join("\n")}\n\n`;
      },
    },
  };
}
