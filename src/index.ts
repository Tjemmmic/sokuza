import { resolve } from 'node:path';

import { VERSION } from './version.js';
import { runStart } from './cli/start.js';
import { runInit } from './cli/init.js';
import { installService, uninstallService } from './cli/service.js';

interface ParsedArgs {
    command: string;
    configPath?: string;
    force: boolean;
    positional: string[];
}

/**
 * Minimal argv parser — no external dep. Supports:
 *   sokuza                          → start
 *   sokuza start [--config PATH]    → start
 *   sokuza init [--force]           → write sokuza.config.yaml from example
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
        'start', 'init', 'install-service', 'uninstall-service',
        'version', '--version', '-v', 'help', '--help', '-h',
    ]);

    let command = 'start';
    let configPath: string | undefined;
    let force = false;
    const positional: string[] = [];

    // If the first non-flag arg is a known command, consume it.
    if (rest.length > 0 && KNOWN_COMMANDS.has(rest[0])) {
        command = rest.shift()!;
    }

    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === '--config' || arg === '-c') {
            configPath = rest[++i];
        } else if (arg.startsWith('--config=')) {
            configPath = arg.slice('--config='.length);
        } else if (arg === '--force' || arg === '-f') {
            force = true;
        } else {
            positional.push(arg);
        }
    }

    // Legacy: `sokuza path/to/config.yaml` was valid before subcommands existed.
    if (command === 'start' && !configPath && positional.length === 1) {
        configPath = positional[0];
    }

    return { command, configPath, force, positional };
}

function printHelp(): void {
    process.stdout.write(`sokuza ${VERSION} — AI workflow automation engine

Usage:
  sokuza [start] [--config PATH]   Start the engine (default)
  sokuza init [--force]            Create sokuza.config.yaml from the bundled example
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
            await runStart({ configPath: args.configPath });
            return;

        case 'init':
            await runInit({ force: args.force });
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
