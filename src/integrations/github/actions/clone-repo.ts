import { mkdtemp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionHandler } from '../../../core/types.js';
import { execGit, execGitOutput } from '../git-helpers.js';

const DEFAULT_DEPTH = 50;
const DEFAULT_NON_PR_DEPTH = 1;

export const githubCloneRepoAction: ActionHandler = async (params, context) => {
    const integrationConfig = context.integrationConfigs?.github;
    const token = (integrationConfig as Record<string, unknown>)?.token as string
        ?? process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error('github-clone-repo: GITHUB_TOKEN required');
    }

    const repo = (params.repo as string)
        ?? context.event.metadata.repo as string;
    const ref = (params.ref as string)
        ?? (context.event.payload as any)?.pull_request?.head?.ref
        ?? '';

    const isPrContext = !!(context.event.metadata.prNumber ?? (context.event.payload as any)?.pull_request?.number);
    const depth = (params.depth as number) ?? (isPrContext ? DEFAULT_DEPTH : DEFAULT_NON_PR_DEPTH);

    if (!repo) {
        throw new Error('github-clone-repo: no repo specified and none found in event metadata');
    }

    const effectiveRef = ref || 'main';

    // `destDir`, when provided, clones into a caller-owned path (e.g. a
    // chat session's persistent workdir) instead of a new `/tmp` dir.
    // The caller is then responsible for cleanup; workflow step teardown
    // skips dirs it didn't create.
    const destDir = params.destDir as string | undefined;
    let tempDir: string;
    if (destDir) {
        if (!existsSync(destDir)) {
            await mkdir(destDir, { recursive: true });
        }
        tempDir = destDir;
    } else {
        tempDir = await mkdtemp(join(tmpdir(), 'sokuza-repo-'));
    }

    context.logger.info(
        { repo, ref: effectiveRef, depth, path: tempDir },
        'Cloning repository',
    );

    const cloneUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
    await execGit(tempDir, ['clone', '--depth', String(depth), '--branch', effectiveRef, cloneUrl, '.']);

    const sha = (await execGitOutput(tempDir, ['rev-parse', 'HEAD'])).trim();

    context.logger.info(
        { repo, ref: effectiveRef, sha: sha.slice(0, 8), path: tempDir },
        'Repository cloned',
    );

    // Re-emit `repo` and `branch` so downstream nodes can wire from this
    // single source instead of also wiring back to the trigger / config.
    return { path: tempDir, repo, branch: effectiveRef, ref: effectiveRef, sha };
};
