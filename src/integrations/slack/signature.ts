import * as crypto from 'node:crypto';

/**
 * Verify a Slack request signature.
 *
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackSignature(
    body: string,
    timestamp: string,
    signature: string,
    signingSecret: string,
): boolean {
    if (!signature || !timestamp || !signingSecret) return false;

    // Reject requests older than 5 minutes to prevent replay attacks
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

    const baseString = `v0:${timestamp}:${body}`;
    const hmac = crypto.createHmac('sha256', signingSecret);
    hmac.update(baseString);
    const computed = `v0=${hmac.digest('hex')}`;

    return crypto.timingSafeEqual(
        Buffer.from(computed),
        Buffer.from(signature),
    );
}
