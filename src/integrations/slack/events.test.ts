import { describe, it, expect } from 'vitest';
import { canonicalSlackEventName, extractChannelInfo } from './events.js';

describe('canonicalSlackEventName', () => {
    it('returns event type as-is when no subtype', () => {
        expect(canonicalSlackEventName('message')).toBe('message');
        expect(canonicalSlackEventName('app_mention')).toBe('app_mention');
    });

    it('joins event type and subtype', () => {
        expect(canonicalSlackEventName('message', 'file_share')).toBe('message.file_share');
    });

    it('returns event type when subtype is undefined', () => {
        expect(canonicalSlackEventName('reaction_added', undefined)).toBe('reaction_added');
    });
});

describe('extractChannelInfo', () => {
    it('extracts from Events API payload', () => {
        const payload = {
            event: {
                channel: 'C12345',
                channel_name: 'general',
                user: 'U12345',
                team: 'T12345',
            },
        };
        const info = extractChannelInfo(payload);
        expect(info.channel).toBe('C12345');
        expect(info.channelName).toBe('general');
        expect(info.user).toBe('U12345');
        expect(info.team).toBe('T12345');
    });

    it('extracts from slash command payload (top-level fields)', () => {
        const payload = {
            channel_id: 'C99999',
            channel_name: 'random',
            user_id: 'U99999',
            team_id: 'T99999',
        };
        const info = extractChannelInfo(payload);
        expect(info.channel).toBe('C99999');
        expect(info.channelName).toBe('random');
        expect(info.user).toBe('U99999');
        expect(info.team).toBe('T99999');
    });

    it('prefers event-level fields over top-level', () => {
        const payload = {
            channel_id: 'top-level',
            event: { channel: 'event-level' },
        };
        const info = extractChannelInfo(payload);
        expect(info.channel).toBe('event-level');
    });

    it('returns undefined for missing fields', () => {
        const info = extractChannelInfo({});
        expect(info.channel).toBeUndefined();
        expect(info.channelName).toBeUndefined();
        expect(info.user).toBeUndefined();
        expect(info.team).toBeUndefined();
    });
});
