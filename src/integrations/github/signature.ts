import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a GitHub webhook signature (HMAC-SHA256).
 *
 * @param payload  Raw request body as a string
 * @param signature  Value of the `x-hub-signature-256` header
 * @param secret  Webhook secret configured in GitHub
 * @returns true if the signature is valid
 */
export function verifyWebhookSignature(
    payload: string,
    signature: string,
    secret: string,
): boolean {
    if (!signature || !secret) return false;

    const expected = `sha256=${createHmac('sha256', secret)
        .update(payload)
        .digest('hex')}`;

    // Constant-time comparison to prevent timing attacks
    try {
        return timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expected),
        );
    } catch {
        return false;
    }
}
