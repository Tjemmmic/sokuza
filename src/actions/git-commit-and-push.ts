import { isAbsolute, normalize } from 'node:path';
import type { ActionHandler } from '../core/types.js';
import { execGit, execGitOutput } from '../integrations/github/git-helpers.js';

/**
 * "git-commit-and-push" — generic git wrapper used by graph workflows
 * after an AI agent or other action has edited files in a workdir.
 * It is provider-agnostic (no GitHub API call) so the same node works
 * for GitHub, GitLab, self-hosted git, etc.
 *
 * Behaviour:
 *   - If `paths` is supplied, only those paths are staged. Each path is
 *     validated against escape (no absolute paths, no `..` segments,
 *     no NUL). Empty list => fail loudly (callers passing [] almost
 *     certainly mean nothing should happen — better to surface that as
 *     an error than silently fall through to add -A).
 *   - If the working tree has nothing to commit after staging, exits
 *     cleanly with `pushed: false, hasChanges: false`.
 *   - `branch` (optional) is checked out before staging. The previous
 *     try-catch fallback masked dirty-tree errors; we now check
 *     existence explicitly, prefer local branches over remote refs,
 *     and surface the original error when checkout fails.
 *   - Push target defaults to `origin`.
 */
export const gitCommitAndPushAction: ActionHandler = async (params, context) => {
    const workdir = params.workdir as string;
    if (!workdir) throw new Error('git-commit-and-push: workdir is required');
    const message = params.message as string;
    if (!message) throw new Error('git-commit-and-push: message is required');

    const remote = (typeof params.remote === 'string' && params.remote) ? params.remote : 'origin';
    const branchOverride = typeof params.branch === 'string' && params.branch ? params.branch : undefined;
    const paths = parsePaths(params.paths);

    if (branchOverride) {
        validateBranchName(branchOverride);
        await switchToBranch(workdir, branchOverride, remote);
    }

    if (paths !== null) {
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

/**
 * Validate + normalise the user-supplied `paths` param. Returns:
 *   - null if the user didn't supply paths at all (caller falls through to add -A)
 *   - string[] of validated relative paths if they did
 *
 * Empty array AND empty/whitespace-only string both throw, so "the user
 * said nothing" has consistent semantics: only `undefined`/`null` (the
 * field genuinely wasn't supplied) opt into add -A.
 */
function parsePaths(raw: unknown): string[] | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'string') {
        const list = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        if (list.length === 0) {
            throw new Error('git-commit-and-push: paths string was empty after trimming — refusing to fall back to add -A silently. Omit the param entirely to stage everything.');
        }
        return list.map((p) => validatePath(p));
    }
    if (!Array.isArray(raw)) {
        throw new Error(`git-commit-and-push: paths must be an array or comma-separated string (got ${typeof raw})`);
    }
    const cleaned = raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (cleaned.length === 0) {
        throw new Error('git-commit-and-push: paths array was empty after dropping non-string entries — refusing to fall back to add -A silently. Omit the param entirely to stage everything.');
    }
    return cleaned.map((p) => validatePath(p));
}

function validatePath(p: string): string {
    if (p.includes('\0')) {
        throw new Error(`git-commit-and-push: path contains NUL character (got ${JSON.stringify(p)})`);
    }
    // Normalise Windows-style backslashes to forward slashes BEFORE the
    // traversal check. On Linux, Node's path.normalize doesn't treat \ as
    // a separator, so '..\\escape' would slip through and reach git as a
    // literal filename — fine on Linux, real sandbox escape on Windows.
    const unified = p.replace(/\\/g, '/');
    if (isAbsolute(unified) || unified.startsWith('/')) {
        throw new Error(`git-commit-and-push: absolute paths are not allowed (got ${JSON.stringify(p)})`);
    }
    const normalised = normalize(unified);
    if (normalised === '..' || normalised.startsWith('../') || normalised.includes('/../')) {
        throw new Error(`git-commit-and-push: path escapes workdir (got ${JSON.stringify(p)})`);
    }
    return p;
}

/**
 * Reject branch names that would confuse git (leading -, named HEAD,
 * whitespace, control chars). We don't try to replicate every rule from
 * git-check-ref-format — we just catch the cases that produce confusing
 * downstream errors. Git itself will reject the rest at checkout time.
 */
function validateBranchName(name: string): void {
    if (name.startsWith('-')) {
        throw new Error(`git-commit-and-push: branch name must not start with "-" (got ${JSON.stringify(name)})`);
    }
    if (name === 'HEAD' || name === 'head') {
        throw new Error(`git-commit-and-push: branch name "HEAD" is reserved — pick a different name`);
    }
    if (/\s/.test(name)) {
        throw new Error(`git-commit-and-push: branch name must not contain whitespace (got ${JSON.stringify(name)})`);
    }
    // Disallow control chars (including NUL).
    if (/[\x00-\x1f\x7f]/.test(name)) {
        throw new Error(`git-commit-and-push: branch name contains control characters (got ${JSON.stringify(name)})`);
    }
}

/**
 * Idempotent branch switch:
 *   1. If the branch exists locally → checkout
 *   2. If it exists only as a remote ref → checkout -B from origin/<branch>
 *   3. Else create a new branch off HEAD with checkout -B
 *
 * If a checkout fails (e.g. dirty worktree would be overwritten), the
 * original error is propagated rather than masked.
 */
async function switchToBranch(workdir: string, branch: string, remote: string): Promise<void> {
    const localExists = await branchExistsLocally(workdir, branch);
    if (localExists) {
        await execGit(workdir, ['checkout', branch]);
        return;
    }
    const remoteRef = `${remote}/${branch}`;
    const remoteExists = await branchExistsLocally(workdir, remoteRef, true);
    if (remoteExists) {
        await execGit(workdir, ['checkout', '-B', branch, remoteRef]);
        return;
    }
    // Create from HEAD. -B replaces an existing branch — but we just verified
    // none exists, so this just creates.
    await execGit(workdir, ['checkout', '-b', branch]);
}

async function branchExistsLocally(workdir: string, ref: string, asRemote = false): Promise<boolean> {
    const fullRef = asRemote ? `refs/remotes/${ref}` : `refs/heads/${ref}`;
    try {
        await execGitOutput(workdir, ['rev-parse', '--verify', '--quiet', fullRef]);
        return true;
    } catch {
        return false;
    }
}
