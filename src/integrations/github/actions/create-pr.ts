import type { ActionHandler } from '../../../core/types.js';
import { GitHubApiClient } from '../api.js';
import { execGit, execGitOutput } from '../git-helpers.js';

/**
 * "github-create-pr" action.
 *
 * Detects changes in a working directory, commits them on a new branch,
 * pushes, and opens a pull request via the GitHub API.
 * **Sokuza controls the push** — not the AI.
 *
 * Params:
 *   - workdir: Path to the cloned repo (from github-clone-repo)
 *   - branch: Branch name for the PR (default: "sokuza/auto-{timestamp}")
 *   - title: PR title (default: "Automated changes by Sokuza")
 *   - body: PR description (default: "")
 *   - base: Base branch (default: "main")
 *   - commit_message: Commit message (default: same as title)
 *
 * Returns: { pr_number, pr_url, branch, has_changes }
 */
export const githubCreatePrAction: ActionHandler = async (params, context) => {
    const workdir = params.workdir as string;
    if (!workdir) {
        throw new Error('github-create-pr: workdir is required');
    }

    const integrationConfig = context.integrationConfigs?.github;
    const token = (integrationConfig as Record<string, unknown>)?.token as string
        ?? process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error('github-create-pr: GITHUB_TOKEN required');
    }

    // Check for changes
    const status = await execGitOutput(workdir, ['status', '--porcelain']);
    if (!status.trim()) {
        context.logger.info('No changes detected, skipping PR creation');
        return { has_changes: false, pr_number: null, pr_url: null, branch: null };
    }

    const timestamp = Date.now();
    const branch = (params.branch as string) ?? `sokuza/auto-${timestamp}`;
    const base = (params.base as string) ?? 'main';
    const title = (params.title as string) ?? 'Automated changes by Sokuza';
    const body = (params.body as string) ?? '';
    const commitMessage = (params.commit_message as string) ?? title;

    // Resolve owner/repo
    const repo = context.event.metadata.repo as string;
    if (!repo) {
        throw new Error('github-create-pr: no repo found in event metadata');
    }
    const [owner, repoName] = repo.split('/');

    context.logger.info(
        { workdir, branch, base, title },
        'Creating PR from local changes',
    );

    // Create branch, stage, commit, push
    await execGit(workdir, ['checkout', '-b', branch]);
    await execGit(workdir, ['add', '-A']);
    await execGit(workdir, ['commit', '-m', commitMessage]);
    await execGit(workdir, ['push', 'origin', branch]);

    // Open PR via GitHub API
    const client = new GitHubApiClient(token);
    const pr = await client.createPullRequest(owner, repoName, {
        title,
        body,
        head: branch,
        base,
    });

    context.logger.info(
        { pr_number: pr.number, pr_url: pr.html_url, branch },
        'Pull request created',
    );

    // Also expose `number`/`url`/`repo` so the new node port names match
    // the audit and the rest of the system.
    return {
        has_changes: true,
        pr_number: pr.number,
        number: pr.number,
        pr_url: pr.html_url,
        url: pr.html_url,
        branch,
        repo,
    };
};
