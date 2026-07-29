// FILE: remarkCodexFileCitations.ts
// Purpose: Turns Codex's inline artifact citation directive into ordinary
//          Markdown links so assistant replies show openable file references.
// Layer: Web chat presentation logic
// Exports: remarkCodexFileCitations, parseCodexFileCitationSegments

const CODEX_FILE_CITATION_PREFIX = ":codex-file-citation{";

export interface CodexFileCitation {
  readonly path: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export type CodexFileCitationSegment =
  | { readonly type: "text"; readonly value: string }
  | {
      readonly type: "citation";
      readonly citation: CodexFileCitation;
      /** Source width retained so thread-marker offsets stay aligned. */
      readonly sourceLength: number;
    };

interface MdastPosition {
  start?: { offset?: number };
  end?: { offset?: number };
}

interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MdastNode[];
  position?: MdastPosition;
}

const SKIPPED_PARENT_TYPES = new Set([
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
]);

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/u.test(value);
}

function restoreLiteralDollarPlaceholders(value: string): string {
  return value.replaceAll("\uE001\uE002", "$").replaceAll("\uE000", "$");
}

function parseCitationAttributes(source: string): Readonly<Record<string, string>> | null {
  const attributes = new Map<string, string>();
  let cursor = 0;

  while (cursor < source.length) {
    while (isWhitespace(source[cursor])) {
      cursor += 1;
    }
    if (cursor >= source.length) {
      break;
    }

    const name = source.slice(cursor).match(/^[A-Za-z][A-Za-z0-9_-]*/u)?.[0];
    if (!name) {
      return null;
    }
    cursor += name.length;

    while (isWhitespace(source[cursor])) {
      cursor += 1;
    }
    if (source[cursor] !== "=") {
      return null;
    }
    cursor += 1;

    while (isWhitespace(source[cursor])) {
      cursor += 1;
    }
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") {
      return null;
    }
    cursor += 1;

    let value = "";
    let closed = false;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === quote) {
        closed = true;
        cursor += 1;
        break;
      }
      if (character === "\\") {
        const next = source[cursor + 1];
        if (next === quote || next === "\\") {
          value += next;
          cursor += 2;
          continue;
        }
      }
      value += character;
      cursor += 1;
    }
    if (!closed || attributes.has(name)) {
      return null;
    }
    attributes.set(name, restoreLiteralDollarPlaceholders(value));
  }

  return Object.fromEntries(attributes);
}

function parseCitationAt(
  value: string,
  start: number,
): { readonly citation: CodexFileCitation; readonly end: number } | null {
  if (!value.startsWith(CODEX_FILE_CITATION_PREFIX, start)) {
    return null;
  }

  const attributeStart = start + CODEX_FILE_CITATION_PREFIX.length;
  let quote: '"' | "'" | null = null;
  let cursor = attributeStart;
  while (cursor < value.length) {
    const character = value[cursor];
    if (quote) {
      if (character === "\\") {
        cursor += 2;
        continue;
      }
      if (character === quote) {
        quote = null;
      }
      cursor += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (character === "}") {
      const attributes = parseCitationAttributes(value.slice(attributeStart, cursor));
      const path = attributes?.path?.trim();
      if (!attributes || !path) {
        return null;
      }
      return {
        citation: { path, attributes },
        end: cursor + 1,
      };
    }
    cursor += 1;
  }

  return null;
}

function citationLocator(citation: CodexFileCitation): string | null {
  const { attributes } = citation;
  const locatorParts: string[] = [];
  const sheet = attributes.sheet;
  const range = attributes.range;
  if (sheet && range) {
    locatorParts.push(`${sheet}!${range}`);
  } else if (sheet) {
    locatorParts.push(sheet);
  } else if (range) {
    locatorParts.push(range);
  }

  if (attributes.page_number) {
    locatorParts.push(`page ${attributes.page_number}`);
  }
  if (attributes.slide_number) {
    locatorParts.push(`slide ${attributes.slide_number}`);
  }

  const lineStart = attributes.line_range_start ?? attributes.line_start;
  const lineEnd = attributes.line_range_end ?? attributes.line_end;
  if (lineStart && lineEnd) {
    locatorParts.push(`L${lineStart}-L${lineEnd}`);
  } else if (lineStart) {
    locatorParts.push(`L${lineStart}`);
  }

  if (attributes.label) {
    locatorParts.push(attributes.label);
  }
  return locatorParts.length > 0 ? locatorParts.join(", ") : null;
}

function citationFileName(path: string): string {
  const trimmedPath = path.replace(/[\\/]+$/u, "");
  const slashIndex = Math.max(trimmedPath.lastIndexOf("/"), trimmedPath.lastIndexOf("\\"));
  return slashIndex >= 0 ? trimmedPath.slice(slashIndex + 1) : trimmedPath;
}

function citationLabel(citation: CodexFileCitation): string {
  const fileName = citationFileName(citation.path) || citation.path;
  const locator = citationLocator(citation);
  return locator ? `${fileName} (${locator})` : fileName;
}

/**
 * Splits source text into ordinary text and validated citation directives. Invalid
 * directives intentionally remain text, so malformed model output is visible
 * instead of silently disappearing from the transcript.
 */
export function parseCodexFileCitationSegments(value: string): CodexFileCitationSegment[] {
  const segments: CodexFileCitationSegment[] = [];
  let literalStart = 0;
  let searchStart = 0;

  while (searchStart < value.length) {
    const citationStart = value.indexOf(CODEX_FILE_CITATION_PREFIX, searchStart);
    if (citationStart === -1) {
      break;
    }
    const parsedCitation = parseCitationAt(value, citationStart);
    if (!parsedCitation) {
      searchStart = citationStart + 1;
      continue;
    }
    if (citationStart > literalStart) {
      segments.push({ type: "text", value: value.slice(literalStart, citationStart) });
    }
    segments.push({
      type: "citation",
      citation: parsedCitation.citation,
      sourceLength: parsedCitation.end - citationStart,
    });
    literalStart = parsedCitation.end;
    searchStart = parsedCitation.end;
  }

  if (literalStart < value.length) {
    segments.push({ type: "text", value: value.slice(literalStart) });
  }
  return segments;
}

function positionForSegment(
  position: MdastPosition | undefined,
  start: number,
  end: number,
): MdastPosition | undefined {
  const offset = position?.start?.offset;
  if (offset === undefined) {
    return undefined;
  }
  return {
    start: { offset: offset + start },
    end: { offset: offset + end },
  };
}

function textNode(value: string, position: MdastPosition | undefined): MdastNode {
  return { type: "text", value, ...(position ? { position } : {}) };
}

function citationLinkNode(citation: CodexFileCitation, position: MdastPosition | undefined): MdastNode {
  return {
    type: "link",
    url: citation.path,
    title: null,
    children: [textNode(citationLabel(citation), undefined)],
    ...(position ? { position } : {}),
  };
}

function citationNodesFromText(node: MdastNode): MdastNode[] {
  const value = node.value ?? "";
  const segments = parseCodexFileCitationSegments(value);
  if (segments.length === 1 && segments[0]?.type === "text" && segments[0].value === value) {
    return [node];
  }

  const nodes: MdastNode[] = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.type === "text") {
      const end = cursor + segment.value.length;
      if (segment.value.length > 0) {
        nodes.push(textNode(segment.value, positionForSegment(node.position, cursor, end)));
      }
      cursor = end;
      continue;
    }

    const end = cursor + segment.sourceLength;
    nodes.push(citationLinkNode(segment.citation, positionForSegment(node.position, cursor, end)));
    cursor = end;
  }
  return nodes;
}

function visitNode(node: MdastNode): void {
  if (!Array.isArray(node.children) || node.children.length === 0) {
    return;
  }

  let changed = false;
  const children: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      const replacements = citationNodesFromText(child);
      if (replacements.length !== 1 || replacements[0] !== child) {
        changed = true;
      }
      children.push(...replacements);
      continue;
    }
    if (!SKIPPED_PARENT_TYPES.has(child.type)) {
      visitNode(child);
    }
    children.push(child);
  }
  if (changed) {
    node.children = children;
  }
}

export function remarkCodexFileCitations() {
  return (tree: unknown) => {
    visitNode(tree as MdastNode);
  };
}
