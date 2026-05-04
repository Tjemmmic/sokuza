import type { ActionHandler } from '../core/types.js';
import { execGit, execGitOutput } from '../integrations/github/git-helpers.js';

/**
 * "git-commit-and-push" — generic git wrapper used by graph workflows
 * after an AI agent or other action has edited files in a workdir.
 * It is provider-agnostic (no GitHub API call) so the same node works
 * for GitHub, GitLab, self-hosted git, etc.
 *
 * Behaviour:
 *   - If `paths` is supplied, only those paths are staged. Otherwise
 *     `git add -A` stages everything.
 *   - If the working tree has nothing to commit after staging, exits
 *     cleanly with `pushed: false, hasChanges: false` instead of
 *     producing an empty commit.
 *   - The current branch is used unless `branch` is supplied — in that
 *     case the action checks out a new branch off HEAD before staging.
 *   - Push target defaults to `origin`.
 */
export const gitCommitAndPushAction: ActionHandler = async (params, context) => {
    const workdir = params.workdir as string;
    if (!workdir) throw new Error('git-commit-and-push: workdir is required');
    const message = params.message as string;
    if (!message) throw new Error('git-commit-and-push: message is required');

    const remote = (params.remote as string) ?? 'origin';
    const branchOverride = params.branch as string | undefined;
    const paths = Array.isArray(params.paths)
        ? (params.paths as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
        : null;

    if (branchOverride) {
        // Idempotent: switch to the branch if it exists, else create it.
        try {
            await execGit(workdir, ['checkout', branchOverride]);
        } catch {
            await execGit(workdir, ['checkout', '-b', branchOverride]);
        }
    }

    if (paths && paths.length > 0) {
        await execGit(workdir, ['add', '--', ...paths]);
    } else {
        await execGit(workdir, ['add', '-A']);
    }

    const status = await execGitOutput(workdir, ['status', '--porcelain']);
    if (!status.trim()) {
        context.logger.info({ workdir }, 'No changes to commit, skipping push');
        return { pushed: false, hasChanges: false, sha: '', branch: '' };
    }

    await execGit(workdir, ['commit', '-m', message]);
    const sha = (await execGitOutput(workdir, ['rev-parse', 'HEAD'])).trim();
    const branch = branchOverride
        ?? (await execGitOutput(workdir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

    context.logger.info({ workdir, branch, sha: sha.slice(0, 8), remote }, 'Pushing commit');
    await execGit(workdir, ['push', remote, branch]);

    return { pushed: true, hasChanges: true, sha, branch };
};
