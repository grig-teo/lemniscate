import { git } from './agent-git.js';
import { scrubAgentScratchFiles } from './workdir-scrub.js';

// Detects whether a run produced REAL repository changes, as opposed to the
// agent's own scratch and the attachments written into the workdir before the
// agent started.
//
// Why not `git status --porcelain` (hasDirtyWorkdir)? writeTaskAttachments
// writes .mcp.json and per-folder AGENTS.md into the workdir BEFORE the agent
// runs, deliberately, and materializeTaskSkills drops .agents/skills/. If the
// agent then only reads files (no implementation), porcelain still reports
// "dirty" on those pre-run files — so implementTask returned a summary, a
// commit/PR holding ONLY attachments was pushed, and the task was marked
// done/awaiting_review with zero real changes. Agent scratch (review verdict,
// transcript, core dumps) tips the verdict the same way, and the existing
// scrubAgentScratchFiles only runs later at commit time — too late.
//
// hasMeaningfulChanges scrubs scratch first, then requires at least one
// changed/untracked path that is NOT a pre-run attachment.

// Returns true when the workdir has at least one real (non-attachment,
// non-scratch) modification, deletion, or new file vs the checked-out base.
export async function hasMeaningfulChanges(workdir: string): Promise<boolean> {
  // Drop review/transcript scratch and core dumps before evaluating so they
  // can never reach a commit or tip the verdict to "changed".
  await scrubAgentScratchFiles(workdir);
  const paths = (
    await git(['status', '--porcelain'], { cwd: workdir })
  )
    .split('\n')
    .map((line) => porcelainPath(line))
    .filter((p): p is string => p !== null);
  if (paths.some((p) => !isPreRunAttachment(p))) return true;
  // The lemcore prompt encourages committing per step, so a fully committed
  // agent leaves a CLEAN workdir — count commits not present on any remote
  // too, or such a run looks like "no changes produced" and falsely fails.
  // Workdirs without remotes (unit tests, odd setups) use the dirty check only.
  if (!(await git(['remote'], { cwd: workdir })).trim()) return false;
  const ahead = (await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: workdir })).trim();
  return Number(ahead) > 0;
}

// Extracts the repo-relative path from one `git status --porcelain` line.
// Format: two status columns, a space, then the path (a rename is "old -> new";
// take the destination). Returns null for blank lines.
function porcelainPath(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  const rest = trimmed.slice(2).trimStart();
  const renamed = rest.split(' -> ');
  return unquote(renamed.at(-1) ?? rest);
}

// git quotes paths containing special chars; strip one layer of quotes.
function unquote(p: string): string {
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

// Paths written into the workdir before the agent runs (task attachments and
// agent scaffolding) that must not, by themselves, count as a produced change.
function isPreRunAttachment(relPath: string): boolean {
  const name = relPath.split('/').pop() ?? relPath;
  if (name === '.mcp.json' || name === 'AGENTS.md') return true;
  // Skill scaffolding materialized for the agent (hermes/lemcore parity).
  if (relPath.startsWith('.agents/skills/')) return true;
  return false;
}
