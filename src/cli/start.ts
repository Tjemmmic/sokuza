import 'dotenv/config';
import { copyFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

import { loadConfig } from '../core/config.js';
import { SokuzaEngine } from '../core/engine.js';
import { GitHubIntegration } from '../integrations/github/index.js';
import { GitHubPollIntegration } from '../integrations/github-poll/index.js';
import { GhCliIntegration } from '../integrations/gh-cli/index.js';
import { isGhInstalled } from '../integrations/gh-cli/exec.js';
import { SlackIntegration } from '../integrations/slack/index.js';
import { WebhookIntegration } from '../integrations/webhook/index.js';
import { CronIntegration } from '../integrations/cron/index.js';

import { logAction } from '../actions/log.js';
import { webhookAction } from '../actions/webhook.js';
import { aiReviewAction } from '../actions/ai-review.js';
import { aiAgentAction } from '../actions/ai-agent.js';
import { addressReviewAction } from '../actions/address-review.js';

import { getNodeRegistry } from '../core/nodes/registry.js';
import { registerBuiltinNodes } from '../core/nodes/builtins.js';

import { locateBundledFile } from './bundled-files.js';

const DEFAULT_CONFIG_NAME = 'sokuza.config.yaml';
const DEFAULT_ENV_NAME = '.env';
const CONFIG_EXAMPLE = 'sokuza.config.example.yaml';
const ENV_EXAMPLE = 'sokuza.env.example';
const HOME_CONFIG_DIR = join(homedir(), '.sokuza');
const HOME_CONFIG_NAME = 'config.yaml';

/** Absolute path to the canonical home-dir config (~/.sokuza/config.yaml). */
export function homeConfigPath(): string {
    return join(HOME_CONFIG_DIR, HOME_CONFIG_NAME);
}

export interface StartOptions {
    configPath?: string;
    /** CLI-level override for the preferred port. Wins over config.server.port. */
    port?: number;
}

/**
 * Default run command — boots the engine and blocks on SIGINT/SIGTERM.
 *
 * If no config path is supplied and no sokuza.config.yaml exists in the
 * current working directory, we bootstrap one from the bundled example so
 * first-run users get a valid config instead of a hard error. The example
 * still has placeholders the user needs to fill in for real integrations,
 * but the server itself will come up on 24847 and the public site can
 * discover it.
 */
export async function runStart(opts: StartOptions): Promise<void> {
    const configPath = opts.configPath
        ?? process.env.SOKUZA_CONFIG
        ?? await ensureDefaultConfig();

    const config = await loadConfig(configPath);

    // `--port` overrides the YAML-configured port. This is the preferred
    // port; the fallback chain still kicks in if it's busy. Useful for
    // one-off testing and for running multiple sokuzas on the same box.
    if (opts.port !== undefined) {
        config.server.port = opts.port;
    }

    const engine = new SokuzaEngine(config, configPath);

    if (config.integrations.github) {
        engine.registerIntegration(new GitHubIntegration());
    }
    if (config.integrations['github-poll']) {
        engine.registerIntegration(new GitHubPollIntegration());
    }

    const ghAvailable = await isGhInstalled();
    if (ghAvailable) {
        if (!config.integrations['gh-cli']) {
            config.integrations['gh-cli'] = {};
        }
        engine.registerIntegration(new GhCliIntegration());
    }

    if (config.integrations.slack) {
        engine.registerIntegration(new SlackIntegration());
    }
    if (config.integrations.webhook) {
        engine.registerIntegration(new WebhookIntegration());
    }
    if (config.integrations.cron) {
        engine.registerIntegration(new CronIntegration());
    }

    engine.registerAction('log', logAction);
    engine.registerAction('webhook', webhookAction);
    engine.registerAction('ai-review', aiReviewAction);
    engine.registerAction('ai-agent', aiAgentAction);
    engine.registerAction('address-review', addressReviewAction);

    // Register the built-in visual node definitions. The dashboard reads
    // the resulting registry via GET /api/nodes to populate the palette.
    registerBuiltinNodes(getNodeRegistry());

    await engine.start();

    const shutdown = async () => {
        await engine.stop();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

/**
 * Resolve the config path to use on `sokuza start` with no explicit override.
 *
 * Order of precedence:
 *   1. A `sokuza.config.yaml` in the current working directory — dev-mode
 *      continues to work unchanged (running from the sokuza repo root).
 *   2. `~/.sokuza/config.yaml` — the canonical location for installed users,
 *      created from the bundled example on first run.
 *
 * This mirrors how gh CLI, AWS CLI, and Claude Code behave: shipped tools
 * keep their config under the user's home directory, not in whatever
 * directory the user happens to be in.
 */
async function ensureDefaultConfig(): Promise<string> {
    const cwd = process.cwd();
    const cwdConfig = resolve(cwd, DEFAULT_CONFIG_NAME);
    if (existsSync(cwdConfig)) {
        return cwdConfig;
    }

    const homeConfig = homeConfigPath();
    if (!existsSync(homeConfig)) {
        await mkdir(HOME_CONFIG_DIR, { recursive: true });
        const example = locateBundledFile(CONFIG_EXAMPLE);
        if (example) {
            await copyFile(example, homeConfig);
            // API keys may end up here via the dashboard — tighten perms
            // so other local users can't read them. Best-effort on platforms
            // where POSIX perms don't apply (Windows).
            await chmod(homeConfig, 0o600).catch(() => undefined);
            process.stderr.write(
                `sokuza: created ${homeConfig} from the bundled example — ` +
                `open the dashboard to configure integrations and AI providers.\n`,
            );
        }
        // If the example isn't bundled, fall through and let loadConfig
        // produce the actionable error.
    }

    return homeConfig;
}
