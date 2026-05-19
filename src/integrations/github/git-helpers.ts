import { spawn, type ChildProcess } from 'node:child_process';
import { abortErrorFromSignal } from '../../core/abort-error.js';

/**
 * Shell out to `git` in a working directory and reject on non-zero exit.
 * Used by clone-repo, create-pr, and commit-and-push — kept here so the
 * three callsites don't drift in error-message format.
 *
 * When `signal` is supplied and aborts mid-execution, the child process
 * receives SIGTERM and the returned promise rejects with `Workflow
 * aborted`. Without this, long-running git operations (push/clone over a
 * slow network) outlive the workflow's per-node timeout: the runtime's
 * outer race unblocks the await, but the underlying child keeps running
 * to completion and may push state the workflow has already abandoned.
 */
export function execGit(cwd: string, args: string[], signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortErrorFromSignal(signal));
            return;
        }
        const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        const stderrChunks: Buffer[] = [];
        child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
        const cleanup = bindAbort(child, signal, reject);
        child.on('close', (code) => {
            cleanup();
            if (code !== 0) {
                const stderr = Buffer.concat(stderrChunks).toString();
                reject(new Error(`git ${args[0]} failed (code ${code}): ${stderr}`));
            } else {
                resolve();
            }
        });
        child.on('error', (err) => {
            cleanup();
            reject(err);
        });
    });
}

/** Same as execGit but returns stdout as a string. */
export function execGitOutput(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortErrorFromSignal(signal));
            return;
        }
        const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
        const cleanup = bindAbort(child, signal, reject);
        child.on('close', (code) => {
            cleanup();
            if (code !== 0) {
                const stderr = Buffer.concat(stderrChunks).toString();
                reject(new Error(`git ${args[0]} failed (code ${code}): ${stderr}`));
            } else {
                resolve(Buffer.concat(chunks).toString());
            }
        });
        child.on('error', (err) => {
            cleanup();
            reject(err);
        });
    });
}

/** Wire the abort signal to the child: send SIGTERM and reject with
 *  "Workflow aborted". Returns a cleanup function that removes the
 *  listener — must be called from every settlement path so the workflow
 *  signal (which can outlive many `execGit` calls) doesn't accumulate
 *  dead listeners. */
function bindAbort(child: ChildProcess, signal: AbortSignal | undefined, reject: (e: Error) => void): () => void {
    if (!signal) return () => undefined;
    const onAbort = () => {
        // SIGTERM lets git flush + exit cleanly; the subsequent 'close'
        // event still fires and goes through the normal exit-code path,
        // but we reject pre-emptively so the caller sees the abort
        // reason instead of a generic "git push failed (code 143)".
        try { child.kill('SIGTERM'); } catch { /* already exited */ }
        reject(abortErrorFromSignal(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
}
