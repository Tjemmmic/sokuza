import type { ActionHandler } from '../core/types.js';

/**
 * Built-in "webhook" action — POSTs a JSON payload to an external URL.
 * Useful for forwarding events to downstream services.
 */
export const webhookAction: ActionHandler = async (params, context) => {
    const url = params.url as string;
    if (!url) {
        throw new Error('webhook action requires a "url" param');
    }

    const body = params.body ?? {
        source: context.event.source,
        event: context.event.event,
        payload: context.event.payload,
    };

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(params.headers as Record<string, string> | undefined),
    };

    const method = (params.method as string) ?? 'POST';

    context.logger.info(
        { action: 'webhook', url, method },
        'Sending outbound webhook',
    );

    const response = await fetch(url, {
        method,
        headers,
        body: JSON.stringify(body),
    });

    const result = {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
    };

    if (!response.ok) {
        context.logger.warn(
            { ...result, url },
            'Outbound webhook returned non-OK status',
        );
    }

    return result;
};
