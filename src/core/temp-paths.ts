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

/** True iff `path` looks like a workflow-managed temp directory. Used by
 *  the runtime's cleanup pass to identify which `path` outputs to delete. */
export function isWorkflowTempPath(path: string): boolean {
    return path.includes(WORKFLOW_TEMP_PREFIX);
}
