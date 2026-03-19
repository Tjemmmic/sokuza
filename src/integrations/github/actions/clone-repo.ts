import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionHandler } from '../../../core/types.js';

/**
 * "github-clone-repo" action.
 *
 * Clones the triggering repo (or any specified repo) to a temp directory.
 * Auto-extracts owner/repo from the event if not explicitly provided.
 *
 * Params:
 *   - repo: "owner/repo" (default: from event metadata)
 *   - ref: git ref to checkout (default: PR head branch or "main")
 *   - depth: clone depth (default: 1 for shallow clone)
 *
 * Returns: { path, repo, ref, sha }
 */
export const githubCloneRepoAction: ActionHandler = async (params, context) => {
    const integrationConfig = context.integrationConfigs?.github;
    const token = (integrationConfig as Record<string, unknown>)?.token as string
        ?? process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error('github-clone-repo: GITHUB_TOKEN required');
    }

    // Resolve repo and ref
    const repo = (params.repo as string)
        ?? context.event.metadata.repo as string;
    const ref = (params.ref as string)
        ?? (context.event.payload as any)?.pull_request?.head?.ref
        ?? 'main';
    const depth = (params.depth as number) ?? 1;

    if (!repo) {
        throw new Error('github-clone-repo: no repo specified and none found in event metadata');
    }

    // Create temp directory
    const tempDir = await mkdtemp(join(tmpdir(), 'sokuza-repo-'));

    context.logger.info(
        { repo, ref, depth, path: tempDir },
        'Cloning repository',
    );

    // Clone with token auth
    const cloneUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
    await execGit(tempDir, ['clone', '--depth', String(depth), '--branch', ref, cloneUrl, '.']);

    // Get the HEAD sha
    const sha = (await execGitOutput(tempDir, ['rev-parse', 'HEAD'])).trim();

    context.logger.info(
        { repo, ref, sha: sha.slice(0, 8), path: tempDir },
        'Repository cloned',
    );

    return { path: tempDir, repo, ref, sha };
};

// ─── Git helpers ────────────────────────────────────────────────────────────

function execGit(cwd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        const stderrChunks: Buffer[] = [];
        child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
        child.on('close', (code) => {
            if (code !== 0) {
                const stderr = Buffer.concat(stderrChunks).toString();
                reject(new Error(`git ${args[0]} failed (code ${code}): ${stderr}`));
            } else {
                resolve();
            }
        });
        child.on('error', reject);
    });
}

function execGitOutput(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.on('close', (code) => {
            if (code !== 0) reject(new Error(`git ${args[0]} failed (code ${code})`));
            else resolve(Buffer.concat(chunks).toString());
        });
        child.on('error', reject);
    });
}
