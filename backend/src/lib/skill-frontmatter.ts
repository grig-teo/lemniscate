// Parser for the YAML frontmatter of Hermes Agent SKILL.md files
// (github.com/NousResearch/hermes-agent). The frontmatter uses a small,
// regular subset of YAML — `key: value` scalars (optionally quoted),
// `[inline, lists]`, block lists (`- item`) and nested maps by indentation —
// so a hand parser keeps the seed script dependency-free. Only the fields
// Lemniscate stores are surfaced: name, description, metadata.hermes.tags
// and the markdown body.

export interface ParsedSkillFile {
  name: string;
  description: string;
  tags: string[];
  // Markdown body after the frontmatter, trimmed.
  content: string;
}

type YamlValue = string | string[] | { [key: string]: YamlValue };

interface FrontmatterLine {
  indent: number;
  text: string;
}

// Strips one pair of matching surrounding quotes from a scalar.
function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

// Splits an inline list body (`a, "b, c", d`) on commas outside quotes.
function splitInlineList(body: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of body) {
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map((item) => unquote(item.trim())).filter((item) => item !== '');
}

function parseScalar(text: string): string | string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return splitInlineList(trimmed.slice(1, -1));
  }
  return unquote(trimmed);
}

// Parses the block starting at lines[start] (all entries indented at least
// `indent`). Returns the parsed value and the index of the first line that
// no longer belongs to the block. A block is a list when its first line is
// a `- item`, otherwise a map.
function parseBlock(
  lines: FrontmatterLine[],
  start: number,
  indent: number,
): [YamlValue, number] {
  const first = lines[start];
  if (first === undefined) return ['', start];
  if (first.text.startsWith('- ')) return parseList(lines, start, indent);
  return parseMap(lines, start, indent);
}

function parseList(
  lines: FrontmatterLine[],
  start: number,
  indent: number,
): [string[], number] {
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.indent !== indent || !line.text.startsWith('- ')) break;
    // List entries are plain scalars in the files we consume; anything more
    // complex (e.g. `- key: value` maps under `setup:`) is kept as raw text.
    items.push(unquote(line.text.slice(2).trim()));
    i += 1;
  }
  return [items, i];
}

function parseMap(
  lines: FrontmatterLine[],
  start: number,
  indent: number,
): [{ [key: string]: YamlValue }, number] {
  const map: { [key: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.indent !== indent || line.text.startsWith('- ')) break;
    const colon = line.text.indexOf(':');
    if (colon === -1) break;
    const key = line.text.slice(0, colon).trim();
    const rest = line.text.slice(colon + 1).trim();
    i += 1;
    if (rest !== '') {
      map[key] = parseScalar(rest);
    } else {
      const next = lines[i];
      if (next !== undefined && next.indent > indent) {
        const [value, nextIndex] = parseBlock(lines, i, next.indent);
        map[key] = value;
        i = nextIndex;
      } else {
        map[key] = '';
      }
    }
  }
  return [map, i];
}

function toLine(raw: string): FrontmatterLine | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return { indent: raw.length - raw.trimStart().length, text: trimmed };
}

function nestedTags(map: { [key: string]: YamlValue }): string[] {
  const metadata = map['metadata'];
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return [];
  const hermes = metadata['hermes'];
  if (typeof hermes !== 'object' || Array.isArray(hermes)) return [];
  const tags = hermes['tags'];
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string' && tags !== '') return [tags];
  return [];
}

// Returns null when the file has no complete frontmatter block or lacks the
// required name/description fields — the seed script skips such files.
export function parseSkillFrontmatter(raw: string): ParsedSkillFile | null {
  const rawLines = raw.split('\n');
  if (rawLines[0]?.trim() !== '---') return null;
  const end = rawLines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return null;

  const lines = rawLines.slice(1, end).map(toLine).filter((l) => l !== null);
  const [map] = parseMap(lines, 0, lines[0]?.indent ?? 0);

  const name = map['name'];
  const description = map['description'];
  if (typeof name !== 'string' || name === '') return null;
  if (typeof description !== 'string' || description === '') return null;

  return {
    name,
    description,
    tags: nestedTags(map),
    content: rawLines.slice(end + 1).join('\n').trim(),
  };
}
