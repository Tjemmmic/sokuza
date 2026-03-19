import 'dotenv/config';

import { loadConfig } from './core/config.js';
import { SokuzaEngine } from './core/engine.js';
import { GitHubIntegration } from './integrations/github/index.js';
import { GitHubPollIntegration } from './integrations/github-poll/index.js';
import { GhCliIntegration } from './integrations/gh-cli/index.js';
import { isGhInstalled } from './integrations/gh-cli/exec.js';
import { SlackIntegration } from './integrations/slack/index.js';
import { WebhookIntegration } from './integrations/webhook/index.js';
import { CronIntegration } from './integrations/cron/index.js';

// ─── Generic actions (source-agnostic) ──────────────────────────────────────
import { logAction } from './actions/log.js';
import { webhookAction } from './actions/webhook.js';
import { aiReviewAction } from './actions/ai-review.js';
import { aiAgentAction } from './actions/ai-agent.js';

async function main(): Promise<void> {
    // Allow config path override via CLI arg or env
    const configPath = process.argv[2] ?? process.env.SOKUZA_CONFIG;

    const config = await loadConfig(configPath);
    const engine = new SokuzaEngine(config, configPath);

    // ─── Register integrations (actions are auto-registered) ────────────
    if (config.integrations.github) {
        engine.registerIntegration(new GitHubIntegration());
    }
    if (config.integrations['github-poll']) {
        engine.registerIntegration(new GitHubPollIntegration());
    }

    // Auto-register gh-cli integration if gh CLI is available
    // This provides zero-config GitHub support via the gh CLI
    const ghAvailable = await isGhInstalled();
    if (ghAvailable) {
        // Register with empty config if not explicitly configured
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

    // ─── Register generic actions ───────────────────────────────────────
    engine.registerAction('log', logAction);
    engine.registerAction('webhook', webhookAction);
    engine.registerAction('ai-review', aiReviewAction);
    engine.registerAction('ai-agent', aiAgentAction);

    // ─── Start ──────────────────────────────────────────────────────────
    await engine.start();

    // ─── Graceful shutdown ──────────────────────────────────────────────
    const shutdown = async () => {
        await engine.stop();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('Fatal error starting Sokuza:', err);
    process.exit(1);
});
