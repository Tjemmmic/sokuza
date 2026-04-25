/**
 * Token-cost computation.
 *
 * Built-in defaults are embedded below; user overrides at
 * `~/.sokuza/pricing.yaml` (or `SOKUZA_PRICING_FILE`) are merged
 * shallowly per-model entry. Costs are computed at read time, never
 * stored on a run record — that way price changes retroactively re-cost
 * historical runs, which is the desired behavior ("estimate at current
 * prices" in the dashboard).
 *
 * Keys are `<provider>/<model>`. The provider matches the registry name
 * (anthropic, zai, openai-compatible, …); model is the exact id used
 * in API calls.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface ModelPrice {
    input_per_mtok: number;
    output_per_mtok: number;
    currency: string;
    updated?: string;
}

export interface PricingTable {
    models: Record<string, ModelPrice>;
}

const BUILTIN: PricingTable = {
    models: {
        // ── Anthropic ───────────────────────────────────────────────
        'anthropic/claude-opus-4-7':
            { input_per_mtok: 15.00, output_per_mtok: 75.00, currency: 'USD', updated: '2026-04-01' },
        'anthropic/claude-sonnet-4-6':
            { input_per_mtok: 3.00, output_per_mtok: 15.00, currency: 'USD', updated: '2026-04-01' },
        'anthropic/claude-haiku-4-5-20251001':
            { input_per_mtok: 0.80, output_per_mtok: 4.00, currency: 'USD', updated: '2026-04-01' },

        // ── ZAI GLM ─────────────────────────────────────────────────
        'zai/glm-4.6':
            { input_per_mtok: 0.50, output_per_mtok: 2.00, currency: 'USD', updated: '2026-04-01' },

        // ── Moonshot ────────────────────────────────────────────────
        'moonshot/kimi-k2':
            { input_per_mtok: 0.60, output_per_mtok: 2.50, currency: 'USD', updated: '2026-04-01' },
    },
};

const USER_PATH = () => process.env.SOKUZA_PRICING_FILE
    ?? join(homedir(), '.sokuza', 'pricing.yaml');

let cached: PricingTable | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 60_000;

export async function loadPricing(): Promise<PricingTable> {
    if (cached && Date.now() - cacheLoadedAt < CACHE_TTL_MS) return cached;
    const user = await readPricingFile(USER_PATH());
    cached = {
        models: { ...BUILTIN.models, ...(user?.models ?? {}) },
    };
    cacheLoadedAt = Date.now();
    return cached;
}

/** Reset the in-memory cache. Tests use this; production rarely needs it. */
export function clearPricingCache(): void {
    cached = null;
    cacheLoadedAt = 0;
}

async function readPricingFile(path: string): Promise<PricingTable | null> {
    if (!existsSync(path)) return null;
    try {
        const raw = await readFile(path, 'utf-8');
        const parsed = yaml.load(raw) as PricingTable | undefined;
        if (!parsed?.models || typeof parsed.models !== 'object') return null;
        return parsed;
    } catch {
        return null;
    }
}

export interface CostEstimate {
    /** Total estimated cost in the model's currency. 0 when no price entry. */
    total: number;
    /** Currency code, propagated from the model's price entry. */
    currency: string;
    /** Whether a pricing entry was found for this model. */
    priced: boolean;
}

/** Compute the estimated cost for a single (provider, model) usage record. */
export function estimateCost(
    provider: string,
    model: string,
    usage: { input_tokens?: number; output_tokens?: number } | undefined,
    pricing: PricingTable,
): CostEstimate {
    if (!usage) return { total: 0, currency: 'USD', priced: false };
    const key = `${provider}/${model}`;
    const price = pricing.models[key];
    if (!price) return { total: 0, currency: 'USD', priced: false };
    const input = (usage.input_tokens ?? 0) / 1_000_000 * price.input_per_mtok;
    const output = (usage.output_tokens ?? 0) / 1_000_000 * price.output_per_mtok;
    return {
        total: input + output,
        currency: price.currency,
        priced: true,
    };
}
