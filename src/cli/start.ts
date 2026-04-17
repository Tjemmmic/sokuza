import 'dotenv/config';
import { copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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

import { locateBundledFile } from './bundled-files.js';

const DEFAULT_CONFIG_NAME = 'sokuza.config.yaml';
const DEFAULT_ENV_NAME = '.env';
const CONFIG_EXAMPLE = 'sokuza.config.example.yaml';
const ENV_EXAMPLE = 'sokuza.env.example';

export interface StartOptions {
    configPath?: string;
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

    await engine.start();

    const shutdown = async () => {
        await engine.stop();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

/**
 * Resolve a config path, creating one from the bundled example if none
 * exists yet. Also drops an `.env` skeleton next to it when missing, so
 * users get one obvious place to paste API keys. Prints a one-line
 * stderr notice for each file scaffolded.
 */
async function ensureDefaultConfig(): Promise<string> {
    const cwd = process.cwd();
    const cwdConfig = resolve(cwd, DEFAULT_CONFIG_NAME);
    const cwdEnv = resolve(cwd, DEFAULT_ENV_NAME);

    if (!existsSync(cwdConfig)) {
        const example = locateBundledFile(CONFIG_EXAMPLE);
        if (example) {
            await copyFile(example, cwdConfig);
            process.stderr.write(
                `sokuza: created ${DEFAULT_CONFIG_NAME} from the bundled example — ` +
                `edit it to enable integrations (github/slack/webhooks/cron).\n`,
            );
        }
        // If the example isn't bundled, fall through and let loadConfig
        // produce the actionable error.
    }

    if (!existsSync(cwdEnv)) {
        const envExample = locateBundledFile(ENV_EXAMPLE);
        if (envExample) {
            await copyFile(envExample, cwdEnv);
            process.stderr.write(
                `sokuza: created ${DEFAULT_ENV_NAME} — ` +
                `add tokens for any integration you enabled in the config.\n`,
            );
        }
    }

    return cwdConfig;
}
