import type {
    FastifyInstance,
    FastifyRequest,
    FastifyReply,
} from 'fastify';
import * as crypto from 'node:crypto';
import type {
    EventHandler,
    EventPayload,
    Integration,
    IntegrationConfig,
} from '../../core/types.js';

interface WebhookEndpointConfig {
    secret?: string;
}

interface WebhookConfig {
    endpoints: Record<string, WebhookEndpointConfig>;
}

/**
 * Generic inbound webhook integration.
 *
 * Accepts arbitrary JSON payloads on `/webhooks/custom/:name`.
 * Each endpoint can optionally have a shared secret for HMAC signature verification.
 *
 * Config:
 * ```yaml
 * integrations:
 *   webhook:
 *     endpoints:
 *       deploy-hook:
 *         secret: "${DEPLOY_HOOK_SECRET}"
 *       monitoring-alert: {}
 * ```
 *
 * Trigger:
 * ```yaml
 * trigger:
 *   source: webhook
 *   event: deploy-hook
 * ```
 */
export class WebhookIntegration implements Integration {
    readonly name = 'webhook';
    readonly supportedEvents: string[] = [];

    private config: WebhookConfig = { endpoints: {} };

    async initialize(config: IntegrationConfig): Promise<void> {
        this.config = {
            endpoints: (config.endpoints as Record<string, WebhookEndpointConfig>) ?? {},
        };
        // Dynamically set supported events from configured endpoint names
        (this as { supportedEvents: string[] }).supportedEvents =
            Object.keys(this.config.endpoints);
    }

    parseEvent(request: FastifyRequest): EventPayload {
        const body = request.body as Record<string, unknown>;
        const endpointName = (request.params as Record<string, string>).name;

        return {
            source: 'webhook',
            event: endpointName,
            timestamp: new Date().toISOString(),
            payload: body,
            metadata: {
                endpoint: endpointName,
                contentType: request.headers['content-type'],
            },
        };
    }

    registerRoutes(server: FastifyInstance, onEvent: EventHandler): void {
        server.post(
            '/webhooks/custom/:name',
            { config: { rawBody: true } },
            async (request: FastifyRequest, reply: FastifyReply) => {
                const endpointName = (request.params as Record<string, string>).name;
                const endpointConfig = this.config.endpoints[endpointName];

                if (!endpointConfig) {
                    return reply.status(404).send({
                        error: `Unknown webhook endpoint: ${endpointName}`,
                    });
                }

                // Optional HMAC verification
                if (endpointConfig.secret) {
                    const rawBody = typeof request.body === 'string'
                        ? request.body
                        : JSON.stringify(request.body);
                    const signature = request.headers['x-webhook-signature'] as string;

                    if (!signature || !verifyHmac(rawBody, signature, endpointConfig.secret)) {
                        return reply.status(401).send({ error: 'Invalid signature' });
                    }
                }

                const event = this.parseEvent(request);
                reply.status(200).send({ received: true });

                onEvent(event).catch(() => { });
            },
        );
    }
}

function verifyHmac(body: string, signature: string, secret: string): boolean {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(body);
    const expected = `sha256=${hmac.digest('hex')}`;

    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
        return false;
    }
}
