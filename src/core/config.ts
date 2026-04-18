import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { SokuzaConfig } from './types.js';
import { normalizeWorkflow } from './templates.js';
import { loadAIProviders } from './ai-providers.js';
import { validateQueueConfig, validateQueueSettings } from './queue-config.js';
import { DEFAULT_PREFERRED_PORT } from '../server/discovery.js';

const DEFAULT_CONFIG_NAME = 'sokuza.config.yaml';

/**
 * Load and validate a Sokuza configuration file.
 *
 * Environment variable interpolation: any value matching `${VAR_NAME}`
 * is replaced with the corresponding env var (or left as-is if unset).
 */
export async function loadConfig(
    configPath?: string,
): Promise<SokuzaConfig> {
    const filePath = resolve(configPath ?? DEFAULT_CONFIG_NAME);
    let raw: string;

    try {
        raw = await readFile(filePath, 'utf-8');
    } catch (err) {
        throw new Error(
            `Failed to read config file at ${filePath}: ${(err as Error).message}`,
        );
    }

    // Interpolate environment variables: ${VAR_NAME}
    const interpolated = raw.replace(
        /\$\{([A-Z_][A-Z0-9_]*)\}/g,
        (_match, varName: string) => process.env[varName] ?? '',
    );

    const parsed = yaml.load(interpolated) as Record<string, unknown>;

    return validateConfig(parsed);
}

async function validateConfig(raw: Record<string, unknown>): Promise<SokuzaConfig> {
    // The `server` block is optional — when absent we fall back to the
    // canonical Sokuza discovery port so the public site can find us.
    const server = (raw.server && typeof raw.server === 'object'
        ? (raw.server as Record<string, unknown>)
        : {});
    if (server.port !== undefined && typeof server.port !== 'number') {
        throw new Error('server.port must be a number when set');
    }
    const port = (server.port as number | undefined) ?? DEFAULT_PREFERRED_PORT;

    const integrations = (raw.integrations ?? {}) as Record<string, unknown>;
    const rawWorkflows = Array.isArray(raw.workflows) ? raw.workflows : [];

    // Normalize each workflow: expand templates + resolve shorthand triggers
    const workflows = await Promise.all(
        rawWorkflows.map((wf: unknown) =>
            normalizeWorkflow(wf as Record<string, unknown>),
        ),
    );

    for (let i = 0; i < workflows.length; i++) {
        const wf = workflows[i];
        if (wf.queue) {
            validateQueueSettings(`workflows[${i}] (${wf.name}).queue`, wf.queue);
        }
    }

    // Build the AI provider registry from the optional `ai:` block.
    // When omitted, loadAIProviders registers built-in defaults.
    const ai = loadAIProviders(raw.ai as Record<string, unknown> | undefined);

    // Validate and parse the optional `queue:` block.
    const queue = validateQueueConfig(raw.queue);

    return {
        server: {
            port,
            // Default to loopback only. Users who want their webhook routes
            // reachable from a tunnel/VPN/LAN must explicitly opt in by
            // setting `server.host: 0.0.0.0` (or a specific IP). The
            // dashboard has no auth today — leaving it loopback-only by
            // default means a laptop on public Wi-Fi isn't exposing it.
            host: (server.host as string) ?? '127.0.0.1',
        },
        integrations: integrations as SokuzaConfig['integrations'],
        workflows,
        ai,
        queue,
    };
}

