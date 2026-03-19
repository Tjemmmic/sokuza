import { describe, it, expect } from 'vitest';
import { verifyWebhookSignature } from '../integrations/github/signature.js';
import { createHmac } from 'node:crypto';

describe('verifyWebhookSignature', () => {
    const secret = 'test-secret-123';

    function sign(payload: string): string {
        return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    }

    it('should accept a valid signature', () => {
        const payload = '{"action":"opened"}';
        const signature = sign(payload);

        expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    });

    it('should reject an invalid signature', () => {
        const payload = '{"action":"opened"}';
        const badSignature = 'sha256=0000000000000000000000000000000000000000000000000000000000000000';

        expect(verifyWebhookSignature(payload, badSignature, secret)).toBe(false);
    });

    it('should reject when signature is empty', () => {
        expect(verifyWebhookSignature('{}', '', secret)).toBe(false);
    });

    it('should reject when secret is empty', () => {
        expect(verifyWebhookSignature('{}', 'sha256=abc', '')).toBe(false);
    });

    it('should reject tampered payload', () => {
        const original = '{"action":"opened"}';
        const tampered = '{"action":"closed"}';
        const signature = sign(original);

        expect(verifyWebhookSignature(tampered, signature, secret)).toBe(false);
    });
});
