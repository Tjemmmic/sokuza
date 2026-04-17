import { request as httpRequest } from 'node:http';
import { listRuntimeStates, type RuntimeState } from '../server/discovery.js';

interface ProbeResult {
    reachable: boolean;
    reportedVersion?: string;
    latencyMs?: number;
    error?: string;
}

/**
 * Print a summary of every locally-running sokuza instance.
 *
 * Two sources of truth are consulted:
 *   1. `~/.sokuza/instances/<pid>.json` — the process self-reported here
 *      at startup. We only list files whose pid is still alive.
 *   2. GET http://127.0.0.1:<port>/health — confirms the HTTP stack is
 *      actually responsive (a pid can be alive but wedged).
 *
 * When those agree, the instance is "healthy". When (1) has an entry but
 * (2) fails, the instance is "stuck" — process alive, server unresponsive.
 */
export async function runStatus(): Promise<void> {
    const states = await listRuntimeStates();

    if (states.length === 0) {
        process.stdout.write(
            `No running sokuza instances found.\n` +
            `Start one with \`sokuza\`, or scaffold a config first with \`sokuza init\`.\n`,
        );
        return;
    }

    for (let i = 0; i < states.length; i++) {
        if (i > 0) process.stdout.write('\n');
        const state = states[i];
        const probe = await probeHealth(state);
        printInstance(state, probe);
    }
}

async function probeHealth(state: RuntimeState): Promise<ProbeResult> {
    return await new Promise<ProbeResult>((resolve) => {
        const started = Date.now();
        const req = httpRequest(
            {
                host: '127.0.0.1',
                port: state.port,
                path: '/health',
                method: 'GET',
                timeout: 1500,
                headers: { Accept: 'application/json' },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
                            app?: unknown;
                            ok?: unknown;
                            version?: unknown;
                        };
                        if (body.app === 'sokuza' && body.ok === true && typeof body.version === 'string') {
                            resolve({
                                reachable: true,
                                reportedVersion: body.version,
                                latencyMs: Date.now() - started,
                            });
                            return;
                        }
                        resolve({ reachable: false, error: 'health response missing sokuza markers' });
                    } catch (err) {
                        resolve({ reachable: false, error: `invalid JSON: ${(err as Error).message}` });
                    }
                });
            },
        );
        req.on('error', (err) => resolve({ reachable: false, error: err.message }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ reachable: false, error: 'timed out after 1.5s' });
        });
        req.end();
    });
}

function printInstance(state: RuntimeState, probe: ProbeResult): void {
    const status = probe.reachable ? 'healthy' : 'stuck';
    const header = `sokuza #${state.pid} — ${status}`;
    process.stdout.write(`${header}\n`);
    process.stdout.write(`${'─'.repeat(header.length)}\n`);
    process.stdout.write(`  port:       ${state.port}\n`);
    process.stdout.write(`  host:       ${state.host}\n`);
    process.stdout.write(`  url:        http://localhost:${state.port}\n`);
    process.stdout.write(`  state file: ~/.sokuza/instances/${state.pid}.json\n`);
    process.stdout.write(`  startedAt:  ${state.startedAt} (${formatUptime(state.startedAt)})\n`);
    process.stdout.write(`  version:    ${state.version}`);
    if (probe.reachable && probe.reportedVersion && probe.reportedVersion !== state.version) {
        process.stdout.write(` (health reports ${probe.reportedVersion})`);
    }
    process.stdout.write('\n');

    if (probe.reachable) {
        process.stdout.write(`  health:     ok (${probe.latencyMs}ms)\n`);
    } else {
        process.stdout.write(`  health:     unreachable — ${probe.error}\n`);
        process.stdout.write(`              (pid is alive but /health didn't answer — try restarting)\n`);
    }
}

function formatUptime(startedAtIso: string): string {
    const started = Date.parse(startedAtIso);
    if (!Number.isFinite(started)) return 'unknown uptime';
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (days > 0) return `up ${days}d ${hours}h`;
    if (hours > 0) return `up ${hours}h ${minutes}m`;
    if (minutes > 0) return `up ${minutes}m ${secs}s`;
    return `up ${secs}s`;
}
