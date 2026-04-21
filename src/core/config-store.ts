import { readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { Logger } from 'pino';
import type { SokuzaConfig } from './types.js';
import { normalizeWorkflow } from './templates.js';
import { loadAIProviders } from './ai-providers.js';
import { validateQueueConfig } from './queue-config.js';

export class ConfigStore {
    private readonly configPath: string;
    private readonly logger: Logger;
    private cache: Record<string, unknown> | null = null;
    private writeLock: Promise<void> = Promise.resolve();

    constructor(configPath: string, logger: Logger) {
        this.configPath = resolve(configPath);
        this.logger = logger;
    }

    /** Absolute path to the backing YAML file. Used by API routes that need
     * to pass a configPath into process-level CLI helpers (e.g. autostart). */
    getPath(): string {
        return this.configPath;
    }

    private withLock<T>(fn: () => Promise<T>): Promise<T> {
        const prev = this.writeLock;
        let resolve!: () => void;
        this.writeLock = new Promise<void>((r) => { resolve = r; });
        return prev.then(() => fn()).finally(resolve);
    }

    async read(): Promise<Record<string, unknown>> {
        if (this.cache) return this.cache;
        const raw = await readFile(this.configPath, 'utf-8');
        const interpolated = this.interpolateEnvVars(raw);
        this.cache = yaml.load(interpolated) as Record<string, unknown>;
        return this.cache;
    }

    async readRaw(): Promise<string> {
        return readFile(this.configPath, 'utf-8');
    }

    async write(data: Record<string, unknown>): Promise<void> {
        return this.withLock(async () => {
            const yamlStr = yaml.dump(data, { lineWidth: 120, noRefs: true });
            await this.atomicWrite(yamlStr);
            this.invalidateCache();
        });
    }

    async writeRaw(rawYaml: string): Promise<void> {
        return this.withLock(async () => {
            yaml.load(rawYaml);
            await this.atomicWrite(rawYaml);
            this.invalidateCache();
        });
    }

    invalidateCache(): void {
        this.cache = null;
    }

    async update<T>(
        mutator: (config: Record<string, unknown>) => T,
    ): Promise<T> {
        return this.withLock(async () => {
            const config = await this.read();
            const result = mutator(config);
            const yamlStr = yaml.dump(config, { lineWidth: 120, noRefs: true });
            await this.atomicWrite(yamlStr);
            this.invalidateCache();
            return result;
        });
    }

    async updateRaw<T>(
        mutator: (config: Record<string, unknown>) => T,
    ): Promise<T> {
        return this.withLock(async () => {
            const raw = await this.readRaw();
            const config = yaml.load(raw) as Record<string, unknown>;
            const result = mutator(config);
            const yamlStr = yaml.dump(config, { lineWidth: 120, noRefs: true });
            await this.atomicWrite(yamlStr);
            this.invalidateCache();
            return result;
        });
    }

    async reloadAndNormalize(): Promise<Partial<SokuzaConfig>> {
        return this.withLock(async () => {
            const raw = await readFile(this.configPath, 'utf-8');
            const interpolated = this.interpolateEnvVars(raw);
            const parsed = yaml.load(interpolated) as Record<string, unknown>;
            this.cache = parsed;

            const rawWorkflows = Array.isArray(parsed.workflows) ? parsed.workflows : [];
            const workflows = await Promise.all(
                rawWorkflows.map((wf: unknown) =>
                    normalizeWorkflow(wf as Record<string, unknown>),
                ),
            );

            const ai = loadAIProviders(parsed.ai as Record<string, unknown> | undefined);
            const queue = validateQueueConfig(parsed.queue);
            const integrations = (parsed.integrations ?? {}) as Record<string, import('./types.js').IntegrationConfig>;

            return { workflows, ai, queue, integrations };
        });
    }

    private async atomicWrite(content: string): Promise<void> {
        const tmpPath = this.configPath + '.tmp';
        try {
            await writeFile(tmpPath, content, 'utf-8');
            await rename(tmpPath, this.configPath);
            // The config may contain AI provider API keys now, so constrain
            // read access to the owner. Best-effort: chmod is a no-op on
            // Windows, and we shouldn't fail the write if perms can't be set.
            await chmod(this.configPath, 0o600).catch(() => undefined);
        } catch (err) {
            try { await unlink(tmpPath); } catch { /* ignore */ }
            throw err;
        }
    }

    private interpolateEnvVars(raw: string): string {
        return raw.replace(
            /\$\{([A-Z_][A-Z0-9_]*)\}/g,
            (_match, varName: string) => process.env[varName] ?? '',
        );
    }
}
