import { resolve } from 'node:path';

// Downstream pipes (head, less, grep with -q) close stdout early. Node
// treats that as an EPIPE write error and crashes the process with a
// stack trace — noisy behaviour for what is really "the reader is done."
// Convert to a clean exit, matching how Unix tools behave.
process.stdout.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
});

import { VERSION } from './version.js';
import { runStart } from './cli/start.js';
import { runInit } from './cli/init.js';
import { runStatus } from './cli/status.js';
import { runLogs } from './cli/logs.js';
import { runToken } from './cli/token.js';
import { installService, uninstallService } from './cli/service.js';

interface ParsedArgs {
    command: string;
    configPath?: string;
    port?: number;
    force: boolean;
    follow: boolean;
    lines?: number;
    rotate: boolean;
    json: boolean;
    positional: string[];
}

/**
 * Minimal argv parser — no external dep. Supports:
 *   sokuza                            → start
 *   sokuza start [--config PATH]      → start
 *   sokuza init [--force]             → write sokuza.config.yaml + .env
 *   sokuza status                     → report running instances
 *   sokuza logs [-f] [-n N]           → show platform-appropriate logs
 *   sokuza install-service [--config PATH]
 *   sokuza uninstall-service
 *   sokuza version | --version | -v
 *   sokuza help    | --help    | -h
 *
 * Backwards-compat: a single positional path is still accepted as a config
 * path for the default start command, matching the pre-CLI behaviour.
 */
function parseArgs(argv: string[]): ParsedArgs {
    const rest = argv.slice(2);
    const KNOWN_COMMANDS = new Set([
        'start', 'init', 'status', 'logs', 'token',
        'install-service', 'uninstall-service',
        'version', '--version', '-v', 'help', '--help', '-h',
    ]);

    let command = 'start';
    let configPath: string | undefined;
    let port: number | undefined;
    let force = false;
    let follow = false;
    let lines: number | undefined;
    let rotate = false;
    let json = false;
    const positional: string[] = [];

    if (rest.length > 0 && KNOWN_COMMANDS.has(rest[0])) {
        command = rest.shift()!;
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
        } else {
            positional.push(arg);
        }
    }

    if (command === 'start' && !configPath && positional.length === 1) {
        configPath = positional[0];
    }

    return { command, configPath, port, force, follow, lines, rotate, json, positional };
}

function printHelp(): void {
    process.stdout.write(`sokuza ${VERSION} — AI workflow automation engine

Usage:
  sokuza [start] [--config PATH] [--port N]
                                   Start the engine (default)
  sokuza init [--force]            Scaffold sokuza.config.yaml and .env
  sokuza status                    Report locally-running instances
  sokuza logs [-f] [-n N]          Show platform-appropriate logs (-f to follow)
  sokuza token [--rotate] [--json] Print the dashboard bearer token
  sokuza install-service [--config PATH]
                                   Install autostart service for this OS
  sokuza uninstall-service         Remove the autostart service
  sokuza version                   Print version and exit
  sokuza help                      Show this message

Docs: https://sokuza.ai
`);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv);

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
            await runInit({ force: args.force });
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

        case 'install-service': {
            const configPath = resolve(
                args.configPath
                ?? process.env.SOKUZA_CONFIG
                ?? 'sokuza.config.yaml',
            );
            const result = await installService({ configPath });
            process.stdout.write(
                `Installed sokuza autostart (${result.platform}).\n` +
                `  Unit: ${result.unitPath}\n` +
                result.followUp.map((l) => `  - ${l}\n`).join(''),
            );
            return;
        }

        case 'uninstall-service': {
            const result = await uninstallService();
            process.stdout.write(
                `Uninstalled sokuza autostart (${result.platform}).\n` +
                result.followUp.map((l) => `  - ${l}\n`).join(''),
            );
            return;
        }

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
