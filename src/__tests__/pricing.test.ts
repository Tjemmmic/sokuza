import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPricing, estimateCost, clearPricingCache } from '../core/pricing.ts';

describe('pricing', () => {
    const previousEnv = process.env.SOKUZA_PRICING_FILE;

    beforeEach(() => {
        clearPricingCache();
    });

    afterEach(() => {
        if (previousEnv === undefined) delete process.env.SOKUZA_PRICING_FILE;
        else process.env.SOKUZA_PRICING_FILE = previousEnv;
        clearPricingCache();
    });

    it('loads built-in defaults', async () => {
        delete process.env.SOKUZA_PRICING_FILE;
        const pricing = await loadPricing();
        expect(pricing.models['anthropic/claude-sonnet-4-6']).toMatchObject({
            input_per_mtok: 3.0,
            output_per_mtok: 15.0,
            currency: 'USD',
        });
    });

    it('user overrides replace per-model entries', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'sokuza-pricing-'));
        try {
            const userFile = join(dir, 'pricing.yaml');
            await writeFile(userFile, [
                'models:',
                '  anthropic/claude-sonnet-4-6:',
                '    input_per_mtok: 99.0',
                '    output_per_mtok: 999.0',
                '    currency: USD',
            ].join('\n'), 'utf-8');
            process.env.SOKUZA_PRICING_FILE = userFile;
            clearPricingCache();
            const pricing = await loadPricing();
            expect(pricing.models['anthropic/claude-sonnet-4-6'].input_per_mtok).toBe(99.0);
            // Other built-in entries remain.
            expect(pricing.models['anthropic/claude-haiku-4-5-20251001']).toBeDefined();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('estimates cost from token counts', async () => {
        const pricing = await loadPricing();
        const result = estimateCost(
            'anthropic',
            'claude-sonnet-4-6',
            { input_tokens: 1_000_000, output_tokens: 100_000 },
            pricing,
        );
        // 1M input * $3 + 100K output * $15/M = 3 + 1.5 = 4.5
        expect(result.total).toBeCloseTo(4.5, 5);
        expect(result.priced).toBe(true);
        expect(result.currency).toBe('USD');
    });

    it('returns priced=false for unknown models', async () => {
        const pricing = await loadPricing();
        const result = estimateCost(
            'never-seen',
            'mystery-model',
            { input_tokens: 1000, output_tokens: 100 },
            pricing,
        );
        expect(result.total).toBe(0);
        expect(result.priced).toBe(false);
    });

    it('handles missing usage', async () => {
        const pricing = await loadPricing();
        const result = estimateCost('anthropic', 'claude-sonnet-4-6', undefined, pricing);
        expect(result.total).toBe(0);
        expect(result.priced).toBe(false);
    });

    it('ignores malformed user override', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'sokuza-pricing-bad-'));
        try {
            const userFile = join(dir, 'pricing.yaml');
            await writeFile(userFile, 'this: is: not: valid: yaml::', 'utf-8');
            process.env.SOKUZA_PRICING_FILE = userFile;
            clearPricingCache();
            const pricing = await loadPricing();
            // Falls back to built-ins.
            expect(pricing.models['anthropic/claude-sonnet-4-6']).toBeDefined();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
