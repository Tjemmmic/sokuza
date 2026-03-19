import { describe, it, expect } from 'vitest';
import {
    canonicalEventName,
    extractRepoName,
    SUPPORTED_GITHUB_EVENTS,
} from '../integrations/github/events.js';

describe('canonicalEventName', () => {
    it('should combine header event and body action', () => {
        expect(canonicalEventName('issues', 'opened')).toBe('issues.opened');
    });

    it('should return just the header event if no action', () => {
        expect(canonicalEventName('push')).toBe('push');
        expect(canonicalEventName('push', undefined)).toBe('push');
    });
});

describe('extractRepoName', () => {
    it('should extract full_name from repository', () => {
        const payload = {
            repository: {
                full_name: 'my-org/my-repo',
            },
        };
        expect(extractRepoName(payload)).toBe('my-org/my-repo');
    });

    it('should return undefined when no repository', () => {
        expect(extractRepoName({})).toBeUndefined();
    });
});

describe('SUPPORTED_GITHUB_EVENTS', () => {
    it('should include core events', () => {
        expect(SUPPORTED_GITHUB_EVENTS).toContain('issues.opened');
        expect(SUPPORTED_GITHUB_EVENTS).toContain('pull_request.opened');
        expect(SUPPORTED_GITHUB_EVENTS).toContain('push');
        expect(SUPPORTED_GITHUB_EVENTS).toContain('issue_comment.created');
    });
});
