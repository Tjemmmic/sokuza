import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import type { SokuzaConfig } from './types.js';
import { normalizeWorkflow } from './templates.js';

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
    if (!raw.server || typeof raw.server !== 'object') {
        throw new Error('Config must include a "server" section');
    }
    const server = raw.server as Record<string, unknown>;
    if (typeof server.port !== 'number') {
        throw new Error('server.port must be a number');
    }

    const integrations = (raw.integrations ?? {}) as Record<string, unknown>;
    const rawWorkflows = Array.isArray(raw.workflows) ? raw.workflows : [];

    // Normalize each workflow: expand templates + resolve shorthand triggers
    const workflows = await Promise.all(
        rawWorkflows.map((wf: unknown) =>
            normalizeWorkflow(wf as Record<string, unknown>),
        ),
    );

    return {
        server: {
            port: server.port as number,
            host: (server.host as string) ?? '0.0.0.0',
        },
        integrations: integrations as SokuzaConfig['integrations'],
        workflows,
    };
}

