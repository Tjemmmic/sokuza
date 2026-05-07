/**
 * Single source of truth for the prefix used by every action that creates
 * an ephemeral working directory the workflow runtime is responsible for
 * deleting at end-of-run.
 *
 * Adding a new action that needs a managed temp dir? Use this constant
 * (or `createWorkflowTempDir()`) so the cleanup heuristic in
 * `workflow.ts#collectTempPath` picks it up automatically. Diverging
 * from the prefix means the directory leaks at run-end — that's a real
 * resource leak across long-running deployments, not just untidy /tmp.
 */
export const WORKFLOW_TEMP_PREFIX = 'sokuza-repo-';

/** True iff `path` looks like a workflow-managed temp directory created
 *  via `mkdtemp(... + WORKFLOW_TEMP_PREFIX)`. Used by the runtime's
 *  cleanup pass to identify which `path` outputs to delete.
 *
 *  The match is anchored at a path-segment boundary and requires the
 *  prefix to be followed by mkdtemp's random suffix (alphanumerics) so
 *  benign user paths like `/home/u/old-sokuza-repo-backup/data` — where
 *  the prefix appears mid-segment — don't qualify for cleanup. Without
 *  the anchor, the previous substring match could schedule a real user
 *  directory for `rm -rf`. */
export function isWorkflowTempPath(path: string): boolean {
    return WORKFLOW_TEMP_PATH_RE.test(path);
}

const WORKFLOW_TEMP_PATH_RE = /(?:^|\/)sokuza-repo-\w+(?:\/|$)/;
