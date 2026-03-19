/**
 * GH CLI execution helper.
 *
 * Provides a typed interface for running `gh` CLI commands and parsing
 * their JSON output. Handles auth detection, timeouts, and error reporting.
 */

import { spawn } from 'node:child_process';

/** Result from a gh CLI command */
export interface GhExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

/** Options for gh CLI execution */
export interface GhExecOptions {
    /** Working directory for the command */
    cwd?: string;
    /** Timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Data to pipe to stdin */
    stdin?: string;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * Check if the `gh` CLI is installed and authenticated.
 * Returns the authenticated username or null if unavailable.
 */
export async function getGhAuthStatus(): Promise<{ available: boolean; username?: string; token?: string }> {
    try {
        const result = await ghExec(['auth', 'status'], { timeout: 5000 });
        if (result.exitCode !== 0) {
            return { available: false };
        }
        // Parse username from output like "Logged in to github.com account USERNAME"
        const combined = result.stdout + result.stderr;
        const match = combined.match(/Logged in to github\.com account (\S+)/);
        return {
            available: true,
            username: match?.[1],
        };
    } catch {
        return { available: false };
    }
}

/**
 * Check if `gh` CLI is installed (quick check, no network).
 */
export async function isGhInstalled(): Promise<boolean> {
    try {
        const result = await ghExec(['--version'], { timeout: 3000 });
        return result.exitCode === 0;
    } catch {
        return false;
    }
}

/**
 * Execute a `gh` CLI command and return raw output.
 */
export function ghExec(args: string[], opts?: GhExecOptions): Promise<GhExecResult> {
    const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;

    return new Promise((resolve, reject) => {
        const child = spawn('gh', args, {
            cwd: opts?.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        if (opts?.stdin) {
            child.stdin.write(opts.stdin);
            child.stdin.end();
        }

        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`gh ${args[0]} timed out after ${timeout}ms`));
        }, timeout);

        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({
                stdout: Buffer.concat(stdoutChunks).toString(),
                stderr: Buffer.concat(stderrChunks).toString(),
                exitCode: code ?? 1,
            });
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Execute a `gh` CLI command and parse JSON output.
 * Throws if the command fails or output is not valid JSON.
 */
export async function ghJson<T = unknown>(args: string[], opts?: GhExecOptions): Promise<T> {
    const result = await ghExec(args, opts);

    if (result.exitCode !== 0) {
        throw new Error(`gh ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }

    const output = result.stdout.trim();
    if (!output) {
        return [] as unknown as T;
    }

    try {
        return JSON.parse(output) as T;
    } catch {
        throw new Error(`gh ${args[0]}: invalid JSON output: ${output.slice(0, 200)}`);
    }
}

/**
 * Execute a `gh` CLI command and return stdout as string.
 * Throws if the command fails.
 */
export async function ghText(args: string[], opts?: GhExecOptions): Promise<string> {
    const result = await ghExec(args, opts);

    if (result.exitCode !== 0) {
        throw new Error(`gh ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }

    return result.stdout;
}
