/**
 * Pure helpers for the inline library-create forms shown when a picker
 * search finds nothing: SKILL.md upload parsing (skills) and MCP server
 * config assembly (.mcp.json fragment shape).
 */

/** Kebab-case slug per the backend rule (^[a-z0-9][a-z0-9-]*$). */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export interface ParsedSkillMarkdown {
  slug: string;
  name: string;
  description: string;
  content: string;
}

// Minimal YAML-frontmatter reader for SKILL.md uploads: `name:` and
// `description:` on single lines between the leading --- fences. Files
// without frontmatter keep their whole text as content and derive the name
// from the file name.
export function parseSkillMarkdown(fileName: string, text: string): ParsedSkillMarkdown {
  const fallbackName = fileName.replace(/\.[^.]+$/, '') || 'custom-skill';
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      slug: slugify(fallbackName),
      name: fallbackName,
      description: '',
      content: text.trim(),
    };
  }
  const [, frontmatter, body] = match;
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || fallbackName;
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  return { slug: slugify(name), name, description, content: body.trim() };
}

/** env lines (KEY=VALUE per line) → record; malformed lines are skipped. */
export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

/** Whitespace-split of an args line; double-quoted segments stay together. */
export function parseArgsLine(text: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    args.push(match[1] ?? match[2]);
  }
  return args;
}

export interface McpFormState {
  command: string;
  args: string;
  env: string;
}

/** `.mcp.json` server fragment: { command, args, env? } — env omitted when empty. */
export function buildMcpConfig(form: McpFormState): Record<string, unknown> {
  const config: Record<string, unknown> = {
    command: form.command.trim(),
    args: parseArgsLine(form.args),
  };
  const env = parseEnvLines(form.env);
  if (Object.keys(env).length > 0) config.env = env;
  return config;
}
