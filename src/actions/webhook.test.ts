import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webhookAction } from './webhook.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function makeContext(overrides?: Partial<import('../core/types.js').ActionContext>) {
    const recordWebhookDelivery = vi.fn();
    return {
        event: {
            source: 'github',
            event: 'push',
            action: 'opened',
            timestamp: '2025-01-01T00:00:00Z',
            payload: { ref: 'refs/heads/main' },
            metadata: { repo: 'org/repo' },
        },
        results: {},
        steps: {},
        integrationConfigs: {},
        ai: { providers: new Map(), defaultProvider: 'test', fallbackChain: [] },
        logger,
        workflowName: 'test-workflow',
        recordWebhookDelivery,
        ...overrides,
    } as import('../core/types.js').ActionContext & { recordWebhookDelivery: ReturnType<typeof vi.fn> };
}

describe('webhookAction', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('throws when url param is missing', async () => {
        const ctx = makeContext();
        await expect(webhookAction({}, ctx)).rejects.toThrow(
            'webhook action requires a "url" param',
        );
    });

    it('sends default body built from event context when params.body is not set', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(null, { status: 200, statusText: 'OK' }),
        );
        const ctx = makeContext();

        await webhookAction({ url: 'https://example.com/hook' }, ctx);

        expect(spy).toHaveBeenCalledTimes(1);
        const [url, init] = spy.mock.calls[0];
        expect(url).toBe('https://example.com/hook');
        expect((init as RequestInit).method).toBe('POST');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body).toEqual({
            source: 'github',
            event: 'push',
            payload: { ref: 'refs/heads/main' },
        });
    });

    it('returns { ok: true } on 200 OK', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(null, { status: 200, statusText: 'OK' }),
        );
        const ctx = makeContext();
        const result = await webhookAction({ url: 'https://example.com/hook' }, ctx);
        expect(result).toEqual({ status: 200, statusText: 'OK', ok: true });
    });

    it('returns { ok: false } on non-OK status without throwing', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(null, { status: 500, statusText: 'Internal Server Error' }),
        );
        const ctx = makeContext();
        const result = await webhookAction({ url: 'https://example.com/hook' }, ctx);
        expect(result).toEqual({ status: 500, statusText: 'Internal Server Error', ok: false });
    });

    it('merges custom headers with default Content-Type', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(null, { status: 200, statusText: 'OK' }),
        );
        const ctx = makeContext();
        await webhookAction(
            { url: 'https://example.com/hook', headers: { 'X-Custom': 'value' } },
            ctx,
        );
        const init = spy.mock.calls[0][1] as RequestInit;
        expect(init.headers).toEqual({
            'Content-Type': 'application/json',
            'X-Custom': 'value',
        });
    });

    it('uses custom HTTP method (PUT)', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(null, { status: 200, statusText: 'OK' }),
        );
        const ctx = makeContext();
        await webhookAction({ url: 'https://example.com/hook', method: 'PUT' }, ctx);
        const init = spy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe('PUT');
    });

    it('calls recordWebhookDelivery with delivery info', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(null, { status: 200, statusText: 'OK' }),
        );
        const ctx = makeContext();
        await webhookAction({ url: 'https://example.com/hook' }, ctx);

        expect(ctx.recordWebhookDelivery).toHaveBeenCalledTimes(1);
        expect(ctx.recordWebhookDelivery).toHaveBeenCalledWith({
            workflowName: 'test-workflow',
            url: 'https://example.com/hook',
            method: 'POST',
            statusCode: 200,
            statusText: 'OK',
            ok: true,
            error: undefined,
        });
    });

    it('throws "Webhook delivery failed" on network error', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
        const ctx = makeContext();
        await expect(
            webhookAction({ url: 'https://example.com/hook' }, ctx),
        ).rejects.toThrow('Webhook delivery failed');
    });
});
