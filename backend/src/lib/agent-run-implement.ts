// Implementation-dispatch helpers for the run-task pipeline (extracted from
// agent-run.ts to keep that module under the line guard): building the
// repository context, and dispatching the implementation to the configured
// task executor (hermes CLI / lemcore loop / internal propose-apply).
import { applyChanges, hasDirtyWorkdir, logEvent } from './agent-git.js';
import { resolveAgentExecutor } from './agent-executor.js';
import { runHermesForTask } from './agent-run-hermes.js';
import { requestChanges, buildSkillsSection, type LlmChangesResponse } from './agent-prompts.js';
import { type LlmRuntime, type TaskWithRepo } from './agent-runtime.js';
import { runLemcoreTask } from './lemcore/run.js';
import { buildRepoContext } from './repo-context.js';
import { loadAgentsMdTemplate, loadTaskSkills } from './task-skills.js';

async function logContextManifest(
  taskId: string,
  files: Array<{ path: string; chars: number }>,
  totalChars: number,
): Promise<void> {
  for (const file of files) {
    await logEvent(taskId, `read ${file.path} (${file.chars} chars)`);
  }
  await logEvent(
    taskId,
    `repository context ready: ${files.length} key file(s), ${totalChars} chars`,
  );
}

// Resolves the task's skills to a system-prompt section; logs which skills
// are active so the run console shows what was injected.
async function taskSkillsSection(task: TaskWithRepo): Promise<string> {
  const skills = await loadTaskSkills(task);
  if (skills.length === 0) return '';
  await logEvent(task.id, `active skills: ${skills.map((s) => s.slug).join(', ')}`);
  return buildSkillsSection(skills);
}

async function proposeTaskChanges(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
): Promise<LlmChangesResponse> {
  await logEvent(task.id, 'building repository context');
  const agentsMdTemplate = await loadAgentsMdTemplate(task.repository);
  const { text: repoContext, files } = await buildRepoContext(
    workdir,
    rt.cfg.contextWindow,
    agentsMdTemplate,
  );
  await logContextManifest(task.id, files, repoContext.length);
  const skillsSection = await taskSkillsSection(task);
  const result = await requestChanges(rt, task, repoContext, undefined, skillsSection);
  await logEvent(task.id, `LLM proposed ${result.changes.length} change(s): ${result.summary}`);
  await logEvent(task.id, `LLM usage so far: ~${rt.usedTokens} tokens`);
  return result;
}

// Runs the configured task executor. Returns the change summary for the
// commit/PR, or null when the workdir has nothing to commit.
// Executor comes from Settings → Agent (per-user override) via
// resolveAgentExecutor — never the bare AGENT_EXECUTOR env alone, or a
// user who picked lemcore would still get hermes when the deployment
// default is hermes.
export async function implementTask(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
  secrets: string[],
  resume: boolean,
  attempt: number,
): Promise<string | null> {
  const userId = task.repository.connection.userId;
  const executor = await resolveAgentExecutor(userId);
  await logEvent(task.id, `executor: ${executor}`);
  if (executor === 'hermes') {
    await runHermesForTask(task, rt, workdir, secrets, resume, attempt);
    return (await hasDirtyWorkdir(workdir)) ? task.title : null;
  }
  if (executor === 'lemcore') {
    const result = await runLemcoreTask({
      taskId: task.id,
      task,
      workdir,
      rt,
      secrets,
      resume,
      attempt,
    });
    return result.changed ? task.title : null;
  }
  const { summary, changes } = await proposeTaskChanges(task, rt, workdir);
  const applied = await applyChanges(task.id, workdir, changes, secrets);
  await logEvent(task.id, `applied ${applied} of ${changes.length} proposed change(s)`);
  if (applied === 0 || !(await hasDirtyWorkdir(workdir))) return null;
  return summary;
}
