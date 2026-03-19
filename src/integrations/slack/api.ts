/**
 * Slack Web API client.
 * Minimal client for posting messages, adding reactions, etc.
 * @see https://api.slack.com/web
 */

const SLACK_API_BASE = 'https://slack.com/api';

export class SlackApiClient {
    private token: string;

    constructor(token: string) {
        this.token = token;
    }

    private headers(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json; charset=utf-8',
        };
    }

    /**
     * Post a message to a channel.
     * @see https://api.slack.com/methods/chat.postMessage
     */
    async postMessage(
        channel: string,
        text: string,
        options?: { thread_ts?: string; blocks?: unknown[] },
    ): Promise<Record<string, unknown>> {
        const res = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({
                channel,
                text,
                ...options,
            }),
        });

        const data = (await res.json()) as Record<string, unknown>;
        if (!data.ok) {
            throw new Error(`Slack API error (chat.postMessage): ${data.error}`);
        }
        return data;
    }

    /**
     * Add a reaction to a message.
     * @see https://api.slack.com/methods/reactions.add
     */
    async addReaction(
        channel: string,
        timestamp: string,
        emoji: string,
    ): Promise<Record<string, unknown>> {
        const res = await fetch(`${SLACK_API_BASE}/reactions.add`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({
                channel,
                timestamp,
                name: emoji.replace(/:/g, ''), // Remove colons if present
            }),
        });

        const data = (await res.json()) as Record<string, unknown>;
        if (!data.ok) {
            throw new Error(`Slack API error (reactions.add): ${data.error}`);
        }
        return data;
    }

    /**
     * Update an existing message.
     * @see https://api.slack.com/methods/chat.update
     */
    async updateMessage(
        channel: string,
        timestamp: string,
        text: string,
    ): Promise<Record<string, unknown>> {
        const res = await fetch(`${SLACK_API_BASE}/chat.update`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ channel, ts: timestamp, text }),
        });

        const data = (await res.json()) as Record<string, unknown>;
        if (!data.ok) {
            throw new Error(`Slack API error (chat.update): ${data.error}`);
        }
        return data;
    }
}
