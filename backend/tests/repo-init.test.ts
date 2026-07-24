import { describe, expect, it, vi } from 'vitest';
import {
  buildRepoInitFiles,
  initializeRepoFiles,
} from '../src/lib/repo-init.js';
import type { CreateFileInput } from '../src/lib/git-providers.js';

// Locking tests for the repo-initialization plan (pure) and the best-effort
// file creation loop used after POST /connections/:id/repositories.

describe('buildRepoInitFiles', () => {
  it('plans a README with the repo name when readme is true', () => {
    const files = buildRepoInitFiles({ repoName: 'demo', readme: true });
    expect(files).toEqual([
      {
        path: 'README.md',
        content: '# demo\n\nCreated with Lemniscate.\n',
        message: 'Add README.md',
      },
    ]);
  });

  it('plans no README when readme is false', () => {
    expect(buildRepoInitFiles({ repoName: 'demo', readme: false })).toEqual([]);
  });

  it('plans an AGENTS.md when content is resolved', () => {
    const files = buildRepoInitFiles({
      repoName: 'demo',
      readme: false,
      agentsMdFiles: [{ folder: '/', content: '# Rules\n' }],
    });
    expect(files).toEqual([
      { path: 'AGENTS.md', content: '# Rules\n', message: 'Add AGENTS.md' },
    ]);
  });

  it('plans both files, README first', () => {
    const files = buildRepoInitFiles({
      repoName: 'demo',
      readme: true,
      agentsMdFiles: [{ folder: '/', content: '# Rules\n' }],
    });
    expect(files.map((file) => file.path)).toEqual(['README.md', 'AGENTS.md']);
  });

  it('treats empty AGENTS.md content as no file', () => {
    expect(
      buildRepoInitFiles({ repoName: 'demo', readme: false, agentsMdFiles: [{ folder: '/', content: '' }] }),
    ).toEqual([]);
  });

  it('plans selected skills as .agents/skills/<slug>/SKILL.md with frontmatter', () => {
    const files = buildRepoInitFiles({
      repoName: 'demo',
      readme: false,
      skillFiles: [{ slug: 'code-review', name: 'Code Review', description: 'Reviews code.', content: 'Do the review.\n' }],
    });
    expect(files).toEqual([
      {
        path: '.agents/skills/code-review/SKILL.md',
        content: '---\nname: Code Review\ndescription: Reviews code.\n---\n\nDo the review.\n',
        message: 'Add skill code-review',
      },
    ]);
  });

  it('plans selected MCP servers as a root .mcp.json', () => {
    const files = buildRepoInitFiles({
      repoName: 'demo',
      readme: false,
      mcpServers: { filesystem: { command: 'npx', args: ['-y', 'server-filesystem', '.'] } },
    });
    expect(files).toEqual([
      {
        path: '.mcp.json',
        content: JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', 'server-filesystem', '.'] } } }, null, 2) + '\n',
        message: 'Add .mcp.json',
      },
    ]);
  });

  it('plans AGENTS.md per folder, nested folders keep their path', () => {
    const files = buildRepoInitFiles({
      repoName: 'demo',
      readme: false,
      agentsMdFiles: [
        { folder: '/', content: '# Root\n' },
        { folder: 'src/api', content: '# API\n' },
      ],
    });
    expect(files.map((file) => file.path)).toEqual(['AGENTS.md', 'src/api/AGENTS.md']);
  });

  it('sanitizes folder input: slashes trimmed, dot-dot rejected', () => {
    expect(() =>
      buildRepoInitFiles({ repoName: 'demo', readme: false, agentsMdFiles: [{ folder: '/src/', content: '# x\n' }] }),
    ).not.toThrow();
    const files = buildRepoInitFiles({ repoName: 'demo', readme: false, agentsMdFiles: [{ folder: '/src/', content: '# x\n' }] });
    expect(files[0]?.path).toBe('src/AGENTS.md');
    expect(() =>
      buildRepoInitFiles({ repoName: 'demo', readme: false, agentsMdFiles: [{ folder: '../evil', content: '# x\n' }] }),
    ).toThrow();
  });
});

describe('initializeRepoFiles', () => {
  function fakeClient(failPaths: string[] = []) {
    const calls: CreateFileInput[] = [];
    return {
      calls,
      client: {
        createFile: async (input: CreateFileInput) => {
          calls.push(input);
          if (failPaths.includes(input.path)) throw new Error('422 boom');
        },
      },
    };
  }

  it('creates every planned file on the default branch and reports success', async () => {
    const { client, calls } = fakeClient();
    const result = await initializeRepoFiles(client, 'ivan/demo', 'main', [
      { path: 'README.md', content: '# demo\n', message: 'Add README.md' },
      { path: 'AGENTS.md', content: '# Rules\n', message: 'Add AGENTS.md' },
    ]);
    expect(calls).toEqual([
      {
        repoFullName: 'ivan/demo',
        path: 'README.md',
        content: '# demo\n',
        message: 'Add README.md',
        branch: 'main',
      },
      {
        repoFullName: 'ivan/demo',
        path: 'AGENTS.md',
        content: '# Rules\n',
        message: 'Add AGENTS.md',
        branch: 'main',
      },
    ]);
    expect(result).toEqual({ readme: true, agentsMd: true, warnings: [] });
  });

  it('reports a per-file failure as a warning and keeps going', async () => {
    const { client, calls } = fakeClient(['README.md']);
    const result = await initializeRepoFiles(client, 'ivan/demo', 'main', [
      { path: 'README.md', content: '# demo\n', message: 'Add README.md' },
      { path: 'AGENTS.md', content: '# Rules\n', message: 'Add AGENTS.md' },
    ]);
    expect(calls).toHaveLength(2);
    expect(result.readme).toBe(false);
    expect(result.agentsMd).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('README.md');
    expect(result.warnings[0]).toContain('422 boom');
  });

  it('reports flags for files that were never planned as false', async () => {
    const { client } = fakeClient();
    const result = await initializeRepoFiles(client, 'ivan/demo', 'main', []);
    expect(result).toEqual({ readme: false, agentsMd: false, warnings: [] });
  });

  it('ignores unknown paths for the success flags', async () => {
    const client = { createFile: vi.fn(async () => {}) };
    const result = await initializeRepoFiles(client, 'ivan/demo', 'main', [
      { path: 'OTHER.txt', content: 'x', message: 'm' },
    ]);
    expect(result).toEqual({ readme: false, agentsMd: false, warnings: [] });
  });
});
