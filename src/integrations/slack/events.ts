/**
 * Slack event types supported by Sokuza.
 * @see https://api.slack.com/events
 */
export const SUPPORTED_SLACK_EVENTS = [
    'message',
    'app_mention',
    'reaction_added',
    'reaction_removed',
    'channel_created',
    'member_joined_channel',
    'slash_command',
] as const;

/**
 * Build a canonical event name from a Slack event.
 * For Events API: `message`, `app_mention`, etc.
 * For slash commands: `slash_command`
 */
export function canonicalSlackEventName(
    eventType: string,
    subtype?: string,
): string {
    if (subtype) return `${eventType}.${subtype}`;
    return eventType;
}

/**
 * Extract channel info from a Slack event payload.
 */
export function extractChannelInfo(payload: Record<string, unknown>): {
    channel?: string;
    channelName?: string;
    user?: string;
    team?: string;
} {
    const event = payload.event as Record<string, unknown> | undefined;
    return {
        channel: (event?.channel ?? payload.channel_id) as string | undefined,
        channelName: (event?.channel_name ?? payload.channel_name) as string | undefined,
        user: (event?.user ?? payload.user_id) as string | undefined,
        team: (payload.team_id ?? event?.team) as string | undefined,
    };
}
