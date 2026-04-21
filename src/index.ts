import { resolve } from 'node:path';

// Downstream pipes (head, less, grep with -q) close stdout early. Node
// treats that as an EPIPE write error and crashes the process with a
// stack trace — noisy behaviour for what is really "the reader is done."
// Convert to a clean exit, matching how Unix tools behave.
process.stdout.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
});

import { VERSION } from './version.js';
import { runStart, homeConfigPath } from './cli/start.js';
import { runInit } from './cli/init.js';
import { runStatus } from './cli/status.js';
import { runLogs } from './cli/logs.js';
import { runToken } from './cli/token.js';
import { runUpdate } from './cli/update.js';
import { maybeNotifyUpdate, refreshUpdateCache } from './cli/update-check.js';
import { installService, uninstallService, serviceStatus, type ServiceStatus } from './cli/service.js';

interface ParsedArgs {
    command: string;
    subcommand?: string;
    configPath?: string;
    port?: number;
    force: boolean;
    follow: boolean;
    lines?: number;
    rotate: boolean;
    json: boolean;
    local: boolean;
    positional: string[];
}

/**
 * Minimal argv parser — no external dep. Supports:
 *   sokuza                            → start
 *   sokuza start [--config PATH]      → start
 *   sokuza init [--force]             → write sokuza.config.yaml + .env
 *   sokuza status                     → report running instances
 *   sokuza logs [-f] [-n N]           → show platform-appropriate logs
 *   sokuza service enable [--config PATH]
 *   sokuza service disable
 *   sokuza service status
 *   sokuza update                     → upgrade via detected package manager
 *   sokuza version | --version | -v
 *   sokuza help    | --help    | -h
 *
 * Backwards-compat: a single positional path is still accepted as a config
 * path for the default start command, matching the pre-CLI behaviour.
 */
function parseArgs(argv: string[]): ParsedArgs {
    const rest = argv.slice(2);
    const KNOWN_COMMANDS = new Set([
        'start', 'init', 'status', 'logs', 'token', 'service', 'update',
        'version', '--version', '-v', 'help', '--help', '-h',
    ]);

    let command = 'start';
    let subcommand: string | undefined;
    let configPath: string | undefined;
    let port: number | undefined;
    let force = false;
    let follow = false;
    let lines: number | undefined;
    let rotate = false;
    let json = false;
    let local = false;
    const positional: string[] = [];

    if (rest.length > 0 && KNOWN_COMMANDS.has(rest[0])) {
        command = rest.shift()!;
    }

    // `service` is a grouped command — the next token (if present and not a
    // flag) is the subcommand. Consume it here so the flag loop below can
    // treat the remainder uniformly.
    if (command === 'service' && rest.length > 0 && !rest[0].startsWith('-')) {
        subcommand = rest.shift();
    }

    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === '--config' || arg === '-c') {
            configPath = rest[++i];
        } else if (arg.startsWith('--config=')) {
            configPath = arg.slice('--config='.length);
        } else if (arg === '--port' || arg === '-p') {
            const v = Number.parseInt(rest[++i], 10);
            if (!Number.isFinite(v) || v <= 0 || v > 65535) {
                throw new Error(`--port expects an integer in 1..65535, got ${rest[i]}`);
            }
            port = v;
        } else if (arg.startsWith('--port=')) {
            const v = Number.parseInt(arg.slice('--port='.length), 10);
            if (!Number.isFinite(v) || v <= 0 || v > 65535) {
                throw new Error(`--port expects an integer in 1..65535, got ${arg}`);
            }
            port = v;
        } else if (arg === '--force' || (arg === '-f' && command !== 'logs')) {
            // `-f` means --force for init, but --follow for logs. Only treat
            // it as --force when the command wouldn't otherwise consume it.
            force = true;
        } else if (arg === '--follow' || (arg === '-f' && command === 'logs')) {
            follow = true;
        } else if (arg === '--lines' || arg === '-n') {
            const v = Number.parseInt(rest[++i], 10);
            if (Number.isFinite(v) && v > 0) lines = v;
        } else if (arg.startsWith('--lines=')) {
            const v = Number.parseInt(arg.slice('--lines='.length), 10);
            if (Number.isFinite(v) && v > 0) lines = v;
        } else if (arg === '--rotate') {
            rotate = true;
        } else if (arg === '--json') {
            json = true;
        } else if (arg === '--local') {
            local = true;
        } else {
            positional.push(arg);
        }
    }

    if (command === 'start' && !configPath && positional.length === 1) {
        configPath = positional[0];
    }

    return { command, subcommand, configPath, port, force, follow, lines, rotate, json, local, positional };
}

function printHelp(): void {
    process.stdout.write(`sokuza ${VERSION} — AI workflow automation engine

Usage:
  sokuza [start] [--config PATH] [--port N]
                                   Start the engine (default)
  sokuza init [--local] [--force]  Scaffold config (default: ~/.sokuza/config.yaml; --local for CWD + .env)
  sokuza status                    Report locally-running instances
  sokuza logs [-f] [-n N]          Show platform-appropriate logs (-f to follow)
  sokuza token [--rotate] [--json] Print the dashboard bearer token
  sokuza service enable [--config PATH]
                                   Install + start the autostart service
  sokuza service disable           Stop + remove the autostart service
  sokuza service status            Report autostart installation and state
  sokuza update                    Upgrade sokuza via its installer (npm, brew, …)
  sokuza version                   Print version and exit
  sokuza help                      Show this message

Env: set NO_UPDATE_NOTIFIER=1 to suppress "update available" notices.
Docs: https://sokuza.ai
`);
}

function printServiceResult(label: string, result: { platform: NodeJS.Platform; unitPath: string; followUp: string[] }): void {
    process.stdout.write(
        `${label} sokuza autostart (${result.platform}).\n` +
        `  Unit: ${result.unitPath}\n` +
        result.followUp.map((l) => `  - ${l}\n`).join(''),
    );
}

function printServiceStatus(s: ServiceStatus): void {
    const fmt = (ok: boolean, y: string, n: string): string => (ok ? y : n);
    process.stdout.write(
        `sokuza service (${s.platform} / ${s.mechanism}):\n` +
        `  Installed: ${fmt(s.installed, 'yes', 'no')}\n` +
        `  Enabled:   ${fmt(s.enabled, 'yes — starts at login', 'no')}\n` +
        `  Active:    ${fmt(s.active, 'yes — running now', 'no')}\n` +
        `  Unit file: ${s.unitPath}\n`,
    );
    for (const note of s.notes) process.stdout.write(`  - ${note}\n`);
    if (!s.installed) {
        process.stdout.write(`\nRun \`sokuza service enable\` to install the autostart unit.\n`);
    }
}

async function runServiceCommand(args: ParsedArgs): Promise<void> {
    switch (args.subcommand) {
        case 'enable':
        case 'install': {
            // For the background service we prefer the home-dir config so
            // autostart doesn't depend on which directory a user happened
            // to be in when they enabled it.
            const configPath = resolve(
                args.configPath
                ?? process.env.SOKUZA_CONFIG
                ?? homeConfigPath(),
            );
            const result = await installService({ configPath });
            printServiceResult('Installed', result);
            return;
        }
        case 'disable':
        case 'uninstall': {
            const result = await uninstallService();
            printServiceResult('Uninstalled', result);
            return;
        }
        case 'status': {
            const s = await serviceStatus();
            printServiceStatus(s);
            return;
        }
        case undefined:
            process.stderr.write(
                `sokuza service: missing subcommand. Expected one of: enable, disable, status.\n\n`,
            );
            printHelp();
            process.exit(2);
            return;
        default:
            process.stderr.write(
                `sokuza service: unknown subcommand "${args.subcommand}". ` +
                `Expected one of: enable, disable, status.\n\n`,
            );
            printHelp();
            process.exit(2);
            return;
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv);

    // Print a cached "update available" notice for interactive invocations.
    // Non-TTY contexts (systemd/launchd service, piped output, CI) stay
    // silent. Runs before the command so the notice always appears first.
    await maybeNotifyUpdate();

    // Populate the update-check cache from the long-running engine process.
    // Short commands exit too quickly to safely hit the network themselves,
    // so we piggy-back on `start` to keep the cache fresh for everyone else.
    if (args.command === 'start') {
        setImmediate(() => { void refreshUpdateCache(); });
    }

    switch (args.command) {
        case 'version':
        case '--version':
        case '-v':
            process.stdout.write(`sokuza ${VERSION}\n`);
            return;

        case 'help':
        case '--help':
        case '-h':
            printHelp();
            return;

        case 'start':
            await runStart({ configPath: args.configPath, port: args.port });
            return;

        case 'init':
            await runInit({ force: args.force, local: args.local });
            return;

        case 'status':
            await runStatus();
            return;

        case 'logs':
            await runLogs({ follow: args.follow, lines: args.lines });
            return;

        case 'token':
            await runToken({ rotate: args.rotate, json: args.json });
            return;

        case 'service':
            await runServiceCommand(args);
            return;

        case 'update':
            await runUpdate();
            return;

        default:
            process.stderr.write(`sokuza: unknown command "${args.command}"\n\n`);
            printHelp();
            process.exit(2);
    }
}

main().catch((err) => {
    console.error('Fatal error:', err?.message ?? err);
    if (process.env.SOKUZA_DEBUG === '1') console.error(err?.stack);
    process.exit(1);
});
