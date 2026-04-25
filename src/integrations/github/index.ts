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
import type { Logger } from 'pino';
import { verifyWebhookSignature } from './signature.js';
import {
    canonicalEventName,
    extractRepoName,
    SUPPORTED_GITHUB_EVENTS,
} from './events.js';

// ─── Integration-owned actions ──────────────────────────────────────────────
import { githubFetchDiffAction } from './actions/fetch-diff.js';
import { githubCommentAction } from './actions/comment.js';
import { githubCloneRepoAction } from './actions/clone-repo.js';
import { githubCreatePrAction } from './actions/create-pr.js';
import { githubFetchReviewsAction } from './actions/github-fetch-reviews.js';
import { githubCreateReviewAction } from './actions/create-review.js';
import { githubAddLabelAction, githubRemoveLabelAction } from './actions/labels.js';

interface GitHubConfig {
    webhookSecret: string;
    token?: string;
    repos?: Array<{ owner: string; name: string }>;
}

export class GitHubIntegration implements Integration {
    readonly name = 'github';
    readonly supportedEvents = [...SUPPORTED_GITHUB_EVENTS];
    readonly actions: Record<string, ActionHandler> = {
        'github-fetch-diff': githubFetchDiffAction,
        'github-comment': githubCommentAction,
        'github-clone-repo': githubCloneRepoAction,
        'github-create-pr': githubCreatePrAction,
        'github-fetch-reviews': githubFetchReviewsAction,
        'github-create-review': githubCreateReviewAction,
        'github-add-label': githubAddLabelAction,
        'github-remove-label': githubRemoveLabelAction,
    };

    private config: GitHubConfig = { webhookSecret: '' };
    private logger!: Logger;

    async initialize(config: IntegrationConfig, logger: Logger): Promise<void> {
        this.logger = logger;
        this.config = {
            webhookSecret: (config.webhookSecret as string) ?? '',
            token: config.token as string | undefined,
            repos: config.repos as GitHubConfig['repos'],
        };

        if (!this.config.webhookSecret) {
            this.logger.warn('No webhookSecret configured — incoming webhook requests will be rejected');
        }
        if (!this.config.token) {
            this.logger.warn('No token configured — GitHub API actions will fail');
        }
    }

    parseEvent(request: FastifyRequest): EventPayload {
        const headerEvent = request.headers['x-github-event'] as string;
        const body = request.body as Record<string, unknown>;
        const action = body.action as string | undefined;

        // Extract repo info
        const repoFullName = extractRepoName(body) ?? 'unknown';
        const [owner, repoName] = repoFullName.includes('/')
            ? repoFullName.split('/')
            : ['unknown', repoFullName];

        // Extract PR/issue number
        const pr = body.pull_request as Record<string, unknown> | undefined;
        const issue = body.issue as Record<string, unknown> | undefined;
        const prNumber = pr?.number as number | undefined;
        const issueNumber = issue?.number as number | undefined;

        return {
            source: 'github',
            event: canonicalEventName(headerEvent, action),
            action,
            timestamp: new Date().toISOString(),
            payload: body,
            metadata: {
                repo: repoFullName,
                owner,
                repoName,
                deliveryId: request.headers['x-github-delivery'] as string,
                hookEvent: headerEvent,
                ...(prNumber !== undefined && { prNumber }),
                ...(issueNumber !== undefined && { issueNumber }),
            },
        };
    }

    registerRoutes(server: FastifyInstance, onEvent: EventHandler): void {
        server.post(
            '/webhooks/github',
            {
                config: { rawBody: true },
            },
            async (request: FastifyRequest, reply: FastifyReply) => {
                // ── Signature verification ───────────────────────────────────
                const signature = request.headers['x-hub-signature-256'] as string;
                const rawBody =
                    typeof request.body === 'string'
                        ? request.body
                        : JSON.stringify(request.body);

                if (
                    !verifyWebhookSignature(
                        rawBody,
                        signature,
                        this.config.webhookSecret,
                    )
                ) {
                    return reply
                        .status(401)
                        .send({ error: 'Invalid webhook signature' });
                }

                // ── Parse and dispatch ───────────────────────────────────────
                const event = this.parseEvent(request);

                // Fire-and-forget: acknowledge GitHub quickly, then process
                reply.status(200).send({ received: true });

                // Process asynchronously (webhook response already sent)
                onEvent(event).catch(() => {
                    // Errors are logged inside the engine; swallow here
                });
            },
        );
    }
}

