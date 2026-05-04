import { spawn } from 'node:child_process';

/**
 * Shell out to `git` in a working directory and reject on non-zero exit.
 * Used by clone-repo, create-pr, and commit-and-push — kept here so the
 * three callsites don't drift in error-message format.
 */
export function execGit(cwd: string, args: string[]): Promise<void> {
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

/** Same as execGit but returns stdout as a string. */
export function execGitOutput(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
        child.on('close', (code) => {
            if (code !== 0) {
                const stderr = Buffer.concat(stderrChunks).toString();
                reject(new Error(`git ${args[0]} failed (code ${code}): ${stderr}`));
            } else {
                resolve(Buffer.concat(chunks).toString());
            }
        });
        child.on('error', reject);
    });
}
