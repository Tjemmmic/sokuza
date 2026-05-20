import { SlackApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';

/**
 * "slack-send-message" action.
 *
 * Posts a message to a Slack channel.
 *
 * Params:
 *   - channel: Channel ID or name (e.g. "#general" or "C01234567")
 *   - text: Message text (supports Slack markdown)
 *   - thread_ts: Optional thread timestamp for threaded replies
 */
export const slackSendMessageAction: ActionHandler = async (params, context) => {
    const slackConfig = context.integrationConfigs.slack;
    const token = (params.token as string) ?? (slackConfig?.botToken as string);

    if (!token) {
        throw new Error(
            'slack-send-message requires a Slack bot token. Set integrations.slack.botToken in config.',
        );
    }

    const channel = params.channel as string;
    if (!channel) {
        throw new Error('slack-send-message requires a "channel" param.');
    }

    const text = params.text as string;
    if (!text) {
        throw new Error('slack-send-message requires a "text" param.');
    }

    const client = new SlackApiClient(token);

    context.logger.info(
        { channel },
        'Posting message to Slack',
    );

    const result = await client.postMessage(channel, text, {
        thread_ts: params.thread_ts as string | undefined,
    });

    context.logger.info(
        { channel, ts: result.ts },
        'Slack message posted',
    );

    return {
        // `timestamp` is the canonical port name (matches slack.react's
        // input). `ts` stays as an alias so workflows authored before the
        // rename keep resolving {{steps.x.ts}}.
        timestamp: result.ts,
        ts: result.ts,
        channel: result.channel,
    };
};
