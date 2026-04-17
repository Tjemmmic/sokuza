import 'dotenv/config';
import { access, copyFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const DEFAULT_CONFIG_NAME = 'sokuza.config.yaml';

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
 * exists yet. Returns an absolute path on success. Prints a one-line
 * notice on stderr when bootstrapping so autostart users notice.
 */
async function ensureDefaultConfig(): Promise<string> {
    const cwdConfig = resolve(process.cwd(), DEFAULT_CONFIG_NAME);
    if (await fileExists(cwdConfig)) return cwdConfig;

    const example = locateBundledExample();
    if (!example) {
        // No example available (unusual) — let loadConfig surface the error.
        return cwdConfig;
    }

    await copyFile(example, cwdConfig);
    process.stderr.write(
        `sokuza: created ${DEFAULT_CONFIG_NAME} from the bundled example — ` +
        `edit it to enable integrations (github/slack/webhooks/cron).\n`,
    );
    return cwdConfig;
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Locate the bundled sokuza.config.example.yaml. When running from source
 * (tsx), it lives at repo root. When running from the built binary under
 * node_modules, it sits next to package.json (two dirs above dist/).
 */
function locateBundledExample(): string | null {
    const here = fileURLToPath(import.meta.url);
    // Both source and build layouts keep the example at ../../sokuza.config.example.yaml
    // relative to this file (src/cli/start.ts → repo root; dist/cli/ is not used — we
    // bundle to a single dist/index.js, so resolve from the bundle location).
    const candidates = [
        resolve(dirname(here), '..', '..', 'sokuza.config.example.yaml'),
        resolve(dirname(here), '..', 'sokuza.config.example.yaml'),
        resolve(dirname(here), 'sokuza.config.example.yaml'),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return null;
}
