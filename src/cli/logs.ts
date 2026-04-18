import { spawn } from 'node:child_process';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export interface LogsOptions {
    /** When true, follow new log lines after printing existing ones. */
    follow?: boolean;
    /** How many lines of history to include. Defaults to 100. */
    lines?: number;
}

/**
 * Print sokuza logs, per-platform:
 *
 *   - Linux:   journalctl --user -u sokuza          (systemd captures stdout)
 *   - macOS:   ~/.sokuza/logs/{stdout,stderr}.log   (launchd redirects there)
 *   - Windows: message — Task Scheduler doesn't capture stdout by default
 *              and we don't currently wrap the invocation
 *
 * When no service is installed yet, prints a hint rather than an error.
 */
export async function runLogs(opts: LogsOptions): Promise<void> {
    const lines = opts.lines ?? 100;

    const plat = platform();
    if (plat === 'linux') return runLinux(opts, lines);
    if (plat === 'darwin') return runMacOS(opts, lines);
    if (plat === 'win32') return runWindows();
    throw new Error(`\`sokuza logs\` is not supported on ${plat}.`);
}

function runLinux(opts: LogsOptions, lines: number): Promise<void> {
    const args = ['--user', '-u', 'sokuza', '-n', String(lines)];
    if (opts.follow) args.push('-f');

    const child = spawn('journalctl', args, { stdio: 'inherit' });
    return new Promise((resolve, reject) => {
        child.on('error', (err) => {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                process.stderr.write(
                    `\`journalctl\` not found on PATH. Sokuza logs on Linux are captured by ` +
                    `systemd's user manager; if systemd isn't in use, check your init system's ` +
                    `log store directly.\n`,
                );
                resolve();
                return;
            }
            reject(err);
        });
        child.on('exit', (code) => {
            if (code === 0 || code === null) resolve();
            else if (code === 1) {
                // journalctl returns 1 when the unit has no logs yet — treat
                // that as a soft error with a hint, not a stack trace.
                process.stderr.write(
                    `No journal entries for sokuza.service. Is the service running? ` +
                    `Try \`sokuza service enable\` if you haven't set up autostart yet.\n`,
                );
                resolve();
            } else {
                reject(new Error(`journalctl exited with code ${code}`));
            }
        });
    });
}

async function runMacOS(opts: LogsOptions, lines: number): Promise<void> {
    const logDir = join(homedir(), '.sokuza', 'logs');
    const stdoutPath = join(logDir, 'stdout.log');
    const stderrPath = join(logDir, 'stderr.log');

    if (!existsSync(stdoutPath) && !existsSync(stderrPath)) {
        process.stderr.write(
            `No logs found in ${logDir}.\n` +
            `macOS captures sokuza logs via launchd when the service is installed — ` +
            `run \`sokuza service enable\` to start recording.\n`,
        );
        return;
    }

    await printLastLines(stdoutPath, lines, 'stdout');
    await printLastLines(stderrPath, lines, 'stderr');

    if (opts.follow) {
        // tail -f behaviour: we defer to the `tail` binary rather than
        // re-implementing it. It is part of POSIX base utilities on macOS.
        const args = ['-f'];
        if (existsSync(stdoutPath)) args.push(stdoutPath);
        if (existsSync(stderrPath)) args.push(stderrPath);
        await new Promise<void>((resolve, reject) => {
            const child = spawn('tail', args, { stdio: 'inherit' });
            child.on('exit', () => resolve());
            child.on('error', reject);
        });
    }
}

function runWindows(): Promise<void> {
    process.stderr.write(
        `\`sokuza logs\` is not yet wired up on Windows.\n\n` +
        `Task Scheduler does not capture stdout by default, so sokuza's log lines ` +
        `don't land in a single file. For now:\n` +
        `  - check Event Viewer → Applications and Services Logs → Microsoft → Windows → TaskScheduler → Operational\n` +
        `  - run \`sokuza\` directly in a terminal to see live output\n`,
    );
    return Promise.resolve();
}

async function printLastLines(file: string, n: number, label: string): Promise<void> {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size === 0) return;

    // Small files: just read the whole thing. Large files: read from a
    // conservative offset — 256 bytes per line is pessimistic enough that
    // we'll have more than N lines in the buffer.
    const budget = Math.min(size, n * 256);
    const start = size - budget;

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
        createReadStream(file, { start })
            .on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
            .on('end', () => resolve())
            .on('error', reject);
    });

    const text = Buffer.concat(chunks).toString('utf-8');
    const allLines = text.split('\n');
    // If we started mid-file, the first line is partial — drop it.
    const safe = start > 0 ? allLines.slice(1) : allLines;
    const tail = safe.slice(-n);

    process.stdout.write(`── ${label} (${file}) ──\n`);
    process.stdout.write(tail.join('\n'));
    if (!tail[tail.length - 1]?.endsWith('\n')) process.stdout.write('\n');
}
