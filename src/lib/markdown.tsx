import React from "react";

/**
 * Minimal Markdown renderer for assistant answers.
 *
 * The system prompt asks Gemini to format answers with bullet points and bold
 * keywords, but the chat bubble rendered the raw string, so users saw literal
 * `**asterisks**` and `-` characters. This covers the subset the model
 * actually emits. It builds React elements rather than HTML strings, so model
 * output can never be injected as markup.
 */

type InlineKey = { key: string };

/** Renders `**bold**`, `*italic*`, `_italic_` and `` `code` `` inside a line. */
function renderInline(text: string, { key }: InlineKey): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Ordered so the longest delimiters win: code, bold, then italic.
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const id = `${key}-i${i++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={id}
          className="px-1 py-0.5 rounded bg-sunken text-ink font-mono text-[0.88em]"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={id} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>
      );
    } else {
      nodes.push(
        <em key={id} className="italic">
          {token.slice(1, -1)}
        </em>
      );
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

const HEADING_SIZES: Record<number, string> = {
  1: "text-[16px] font-semibold tracking-[-0.011em] mt-1",
  2: "text-[15px] font-semibold tracking-[-0.008em] mt-1",
  3: "text-[14px] font-semibold",
  4: "text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2",
};

export const Markdown: React.FC<{ text: string }> = ({ text }) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];

  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let codeLines: string[] | null = null;
  let blockIndex = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const key = `p${blockIndex++}`;
    blocks.push(
      <p key={key} className="whitespace-pre-wrap break-words">
        {renderInline(paragraph.join("\n"), { key })}
      </p>
    );
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    const key = `l${blockIndex++}`;
    const items = listItems.map((item, idx) => (
      <li key={`${key}-${idx}`} className="break-words">
        {renderInline(item, { key: `${key}-${idx}` })}
      </li>
    ));
    blocks.push(
      listOrdered ? (
        <ol key={key} className="list-decimal pl-5 space-y-1">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc pl-5 space-y-1">
          {items}
        </ul>
      )
    );
    listItems = [];
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");

    // Fenced code block
    if (/^\s*```/.test(line)) {
      if (codeLines === null) {
        flushAll();
        codeLines = [];
      } else {
        blocks.push(
          <pre
            key={`c${blockIndex++}`}
            className="bg-sunken border border-line text-ink rounded-xl p-3 overflow-x-auto text-[0.85em] font-mono"
          >
            <code>{codeLines.join("\n")}</code>
          </pre>
        );
        codeLines = null;
      }
      continue;
    }
    if (codeLines !== null) {
      codeLines.push(rawLine);
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    // Thematic break. Without this, models emitting `---` between sections
    // had it rendered as literal dashes in the middle of the answer.
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      blocks.push(<hr key={`hr${blockIndex++}`} className="border-line my-1" />);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const key = `h${blockIndex++}`;
      blocks.push(
        <p key={key} className={`${HEADING_SIZES[level]} text-ink`}>
          {renderInline(heading[2], { key })}
        </p>
      );
      continue;
    }

    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (listOrdered) flushList();
      listOrdered = false;
      listItems.push(bullet[1]);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      if (!listOrdered) flushList();
      listOrdered = true;
      listItems.push(numbered[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (codeLines !== null && codeLines.length > 0) {
    // Unterminated fence: show what we captured rather than dropping it.
    blocks.push(
      <pre
        key={`c${blockIndex++}`}
        className="bg-sunken border border-line text-ink rounded-xl p-3 overflow-x-auto text-[0.85em] font-mono"
      >
        <code>{codeLines.join("\n")}</code>
      </pre>
    );
  }
  flushAll();

  return <div className="space-y-2">{blocks}</div>;
};
