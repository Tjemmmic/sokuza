import type { ActionHandler } from '../core/types.js';

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

    let statusCode = 0;
    let statusText = '';
    let ok = false;
    let errorMessage: string | undefined;

    try {
        const response = await fetch(url, {
            method,
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });

        statusCode = response.status;
        statusText = response.statusText;
        ok = response.ok;

        if (!response.ok) {
            context.logger.warn(
                { status: statusCode, statusText, url },
                'Outbound webhook returned non-OK status',
            );
        }
    } catch (err: any) {
        errorMessage = err.message ?? String(err);
        context.logger.error({ err, url }, 'Outbound webhook request failed');
    }

    if (context.recordWebhookDelivery) {
        context.recordWebhookDelivery({
            workflowName: context.workflowName ?? 'unknown',
            url,
            method,
            statusCode,
            statusText,
            ok,
            error: errorMessage,
        });
    }

    if (errorMessage) {
        throw new Error(`Webhook delivery failed: ${errorMessage}`);
    }

    return { status: statusCode, statusText, ok };
};
