import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from './signature.js';

describe('verifyWebhookSignature', () => {
    const secret = 'webhook-secret-123';
    const payload = '{"action":"push","ref":"refs/heads/main"}';

    function sign(p: string, s: string): string {
        return `sha256=${createHmac('sha256', s).update(p).digest('hex')}`;
    }

    it('accepts a valid signature', () => {
        const signature = sign(payload, secret);
        expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    });

    it('rejects an invalid signature', () => {
        expect(verifyWebhookSignature(payload, 'sha256=badbadbad', secret)).toBe(false);
    });

    it('handles empty payload with valid signing', () => {
        const signature = sign('', secret);
        expect(verifyWebhookSignature('', signature, secret)).toBe(true);
    });

    it('returns false when secret is empty', () => {
        const signature = sign(payload, secret);
        expect(verifyWebhookSignature(payload, signature, '')).toBe(false);
    });

    it('returns false when signature is empty', () => {
        expect(verifyWebhookSignature(payload, '', secret)).toBe(false);
    });

    it('rejects tampered payload after signing', () => {
        const signature = sign(payload, secret);
        expect(verifyWebhookSignature(payload + 'tampered', signature, secret)).toBe(false);
    });

    it('returns false for non-hex signature string', () => {
        expect(verifyWebhookSignature(payload, 'sha256=NOT_HEX_AT_ALL!!', secret)).toBe(false);
    });
});
