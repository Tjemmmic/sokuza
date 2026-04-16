import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as crypto from 'node:crypto';
import { verifySlackSignature } from './signature.js';

describe('verifySlackSignature', () => {
    const signingSecret = 'slack-signing-secret-abc';

    function signSlack(body: string, timestamp: string, secret: string): string {
        const baseString = `v0:${timestamp}:${body}`;
        return `v0=${crypto.createHmac('sha256', secret).update(baseString).digest('hex')}`;
    }

    function currentTimestamp(): string {
        return String(Math.floor(Date.now() / 1000));
    }

    it('accepts a valid signature', () => {
        const body = 'payload={"text":"hello"}';
        const ts = currentTimestamp();
        const sig = signSlack(body, ts, signingSecret);
        expect(verifySlackSignature(body, ts, sig, signingSecret)).toBe(true);
    });

    it('rejects an invalid signature', () => {
        const body = 'payload={"text":"hello"}';
        const ts = currentTimestamp();
        const fakeSig = 'v0=' + 'a'.repeat(64);
        expect(verifySlackSignature(body, ts, fakeSig, signingSecret)).toBe(false);
    });

    it('rejects expired timestamps (>5 minutes old)', () => {
        const body = 'payload={"text":"hello"}';
        const oldTimestamp = String(Math.floor(Date.now() / 1000) - 600);
        const sig = signSlack(body, oldTimestamp, signingSecret);
        expect(verifySlackSignature(body, oldTimestamp, sig, signingSecret)).toBe(false);
    });

    it('rejects future timestamps (>5 minutes ahead)', () => {
        const body = 'payload={"text":"hello"}';
        const futureTimestamp = String(Math.floor(Date.now() / 1000) + 600);
        const sig = signSlack(body, futureTimestamp, signingSecret);
        expect(verifySlackSignature(body, futureTimestamp, sig, signingSecret)).toBe(false);
    });

    it('accepts empty body with valid signature', () => {
        const ts = currentTimestamp();
        const sig = signSlack('', ts, signingSecret);
        expect(verifySlackSignature('', ts, sig, signingSecret)).toBe(true);
    });

    it('returns false when timestamp is empty', () => {
        const body = 'payload={"text":"hello"}';
        expect(verifySlackSignature(body, '', 'v0=something', signingSecret)).toBe(false);
    });

    it('returns false when signature is empty', () => {
        const body = 'payload={"text":"hello"}';
        const ts = currentTimestamp();
        expect(verifySlackSignature(body, ts, '', signingSecret)).toBe(false);
    });

    it('returns false when signing secret is empty', () => {
        const body = 'payload={"text":"hello"}';
        const ts = currentTimestamp();
        const sig = signSlack(body, ts, signingSecret);
        expect(verifySlackSignature(body, ts, sig, '')).toBe(false);
    });
});
