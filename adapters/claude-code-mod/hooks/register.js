// bandit-guard mod: before a file-writing tool runs, ask `bandit guard` whether the path is allowed.
// No import and no require: a mod reaches processes only through `$`.
export function register(on, options) {
  const cmd = String(options?.bandit || "bandit").trim().split(/\s+/);

  on('tool.call', { tool: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] }, async ($, e, next) => {
    const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path;
    if (typeof path !== 'string' || !path) return next(e);

    const cannotRun = (reason) => ({
      deny: `bandit guard could not run (${reason}); refusing the edit. Set the bandit option of the bandit-guard mod.`,
    });

    let verdict;
    try {
      const cwd = await $.session.cwd();
      const r = await $.process.run([...cmd, 'guard', '--json', '--repo', cwd, path], { cwd });
      const last = String(r?.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop();
      if (!last) return cannotRun(`no output, exit ${r?.exitCode}`);
      verdict = JSON.parse(last);
    } catch (err) {
      return cannotRun(err?.message || String(err));
    }

    if (verdict?.allowed === true) return next(e);
    if (verdict?.allowed === false) {
      const hits = Array.isArray(verdict.hits) ? verdict.hits.join(', ') : '';
      return { deny: `bandit guard: ${path} is protected (${hits}). The judge rejects any change to it; leave it to a human.` };
    }
    return cannotRun('unexpected output');
  });
}
