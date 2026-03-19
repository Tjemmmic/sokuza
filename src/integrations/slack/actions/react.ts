import { SlackApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';

/**
 * "slack-react" action.
 *
 * Adds a reaction emoji to a Slack message.
 *
 * Params:
 *   - channel: Channel ID (auto-resolved from event if available)
 *   - timestamp: Message timestamp (auto-resolved from event if available)
 *   - emoji: Emoji name without colons (e.g. "thumbsup", "eyes", "white_check_mark")
 */
export const slackReactAction: ActionHandler = async (params, context) => {
    const slackConfig = context.integrationConfigs.slack;
    const token = (params.token as string) ?? (slackConfig?.botToken as string);

    if (!token) {
        throw new Error(
            'slack-react requires a Slack bot token. Set integrations.slack.botToken in config.',
        );
    }

    const channel = (params.channel as string)
        ?? (context.event.metadata.channel as string);
    if (!channel) {
        throw new Error('slack-react requires a "channel" param or a Slack event with channel metadata.');
    }

    const timestamp = (params.timestamp as string)
        ?? (context.event.metadata.messageTs as string);
    if (!timestamp) {
        throw new Error('slack-react requires a "timestamp" param or a Slack event with message timestamp.');
    }

    const emoji = params.emoji as string;
    if (!emoji) {
        throw new Error('slack-react requires an "emoji" param (e.g. "thumbsup").');
    }

    const client = new SlackApiClient(token);

    context.logger.info(
        { channel, emoji },
        'Adding reaction to Slack message',
    );

    await client.addReaction(channel, timestamp, emoji);

    context.logger.info(
        { channel, emoji },
        'Reaction added',
    );

    return { channel, timestamp, emoji };
};
