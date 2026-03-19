import type {
    FastifyInstance,
    FastifyRequest,
    FastifyReply,
} from 'fastify';
import type {
    ActionHandler,
    EventHandler,
    EventPayload,
    Integration,
    IntegrationConfig,
} from '../../core/types.js';
import { verifySlackSignature } from './signature.js';
import { canonicalSlackEventName, extractChannelInfo, SUPPORTED_SLACK_EVENTS } from './events.js';

// ─── Integration-owned actions ──────────────────────────────────────────────
import { slackSendMessageAction } from './actions/send-message.js';
import { slackReactAction } from './actions/react.js';

interface SlackConfig {
    botToken: string;
    signingSecret: string;
}

export class SlackIntegration implements Integration {
    readonly name = 'slack';
    readonly supportedEvents = [...SUPPORTED_SLACK_EVENTS];
    readonly actions: Record<string, ActionHandler> = {
        'slack-send-message': slackSendMessageAction,
        'slack-react': slackReactAction,
    };

    private config: SlackConfig = { botToken: '', signingSecret: '' };

    async initialize(config: IntegrationConfig): Promise<void> {
        const botToken = config.botToken as string | undefined;
        const signingSecret = config.signingSecret as string | undefined;

        if (!botToken) {
            throw new Error('Slack integration requires "botToken" in config');
        }
        if (!signingSecret) {
            throw new Error('Slack integration requires "signingSecret" in config');
        }

        this.config = { botToken, signingSecret };
    }

    parseEvent(request: FastifyRequest): EventPayload {
        const body = request.body as Record<string, unknown>;

        // Events API wraps the event in an `event` field
        const slackEvent = body.event as Record<string, unknown> | undefined;
        const eventType = (slackEvent?.type ?? body.command ? 'slash_command' : 'unknown') as string;
        const subtype = slackEvent?.subtype as string | undefined;

        const channelInfo = extractChannelInfo(body);

        return {
            source: 'slack',
            event: canonicalSlackEventName(eventType, subtype),
            timestamp: new Date().toISOString(),
            payload: body,
            metadata: {
                channel: channelInfo.channel,
                channelName: channelInfo.channelName,
                user: channelInfo.user,
                team: channelInfo.team,
                messageTs: (slackEvent?.ts ?? slackEvent?.message_ts) as string | undefined,
                eventId: body.event_id as string | undefined,
            },
        };
    }

    registerRoutes(server: FastifyInstance, onEvent: EventHandler): void {
        // ─── Events API endpoint ────────────────────────────────────────
        server.post(
            '/webhooks/slack/events',
            { config: { rawBody: true } },
            async (request: FastifyRequest, reply: FastifyReply) => {
                const rawBody = typeof request.body === 'string'
                    ? request.body
                    : JSON.stringify(request.body);
                const body = request.body as Record<string, unknown>;

                // Handle URL verification challenge (Slack sends this once during setup)
                if (body.type === 'url_verification') {
                    return reply.send({ challenge: body.challenge });
                }

                // Verify signature
                const timestamp = request.headers['x-slack-request-timestamp'] as string;
                const signature = request.headers['x-slack-signature'] as string;

                if (!verifySlackSignature(rawBody, timestamp, signature, this.config.signingSecret)) {
                    return reply.status(401).send({ error: 'Invalid signature' });
                }

                // Parse and dispatch
                const event = this.parseEvent(request);

                // Acknowledge immediately (Slack requires < 3s response)
                reply.status(200).send({ ok: true });

                // Process asynchronously
                onEvent(event).catch(() => { });
            },
        );

        // ─── Slash commands endpoint ────────────────────────────────────
        server.post(
            '/webhooks/slack/commands',
            { config: { rawBody: true } },
            async (request: FastifyRequest, reply: FastifyReply) => {
                const rawBody = typeof request.body === 'string'
                    ? request.body
                    : JSON.stringify(request.body);

                const timestamp = request.headers['x-slack-request-timestamp'] as string;
                const signature = request.headers['x-slack-signature'] as string;

                if (!verifySlackSignature(rawBody, timestamp, signature, this.config.signingSecret)) {
                    return reply.status(401).send({ error: 'Invalid signature' });
                }

                const body = request.body as Record<string, unknown>;

                const event: EventPayload = {
                    source: 'slack',
                    event: 'slash_command',
                    timestamp: new Date().toISOString(),
                    payload: body,
                    metadata: {
                        command: body.command as string,
                        text: body.text as string,
                        channel: body.channel_id as string,
                        channelName: body.channel_name as string,
                        user: body.user_id as string,
                        team: body.team_id as string,
                        responseUrl: body.response_url as string,
                    },
                };

                // Acknowledge (the workflow will respond via response_url or slack-send-message)
                reply.status(200).send({ text: '⏳ Processing...' });

                onEvent(event).catch(() => { });
            },
        );
    }
}
