// Post-processes bash error output to append a one-line actionable hint for
// common failure classes, so the model gets a nudge toward the fix instead of
// just the raw stderr. Split out of tools.ts to stay under the file-size limit.

const ERROR_HINTS: { match: RegExp; hint: string }[] = [
  { match: /command not found/i, hint: 'Command not found. Check that the tool/binary is installed and on PATH.' },
  { match: /ENOENT/i, hint: 'File or directory not found. Check the path exists.' },
  { match: /EACCES|permission denied/i, hint: 'Permission denied. Check file ownership or use chmod.' },
  { match: /npm error.*ENEEDAUTH/i, hint: 'npm authentication required. This command needs a registry token.' },
  { match: /error TS\d+:/i, hint: 'TypeScript compilation error. Fix the type error above.' },
  { match: /Cannot find module/i, hint: 'Module not found. Run npm install or check the import path.' },
  { match: /fatal: not a git repository/i, hint: 'Not in a git repository. Check your working directory.' },
];

export function enhanceErrorOutput(output: string): string {
  for (const { match, hint } of ERROR_HINTS) {
    if (match.test(output)) return `${output}\n\n💡 ${hint}`;
  }
  return output;
}
