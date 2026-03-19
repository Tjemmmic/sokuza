import { describe, it, expect } from 'vitest';
import { canonicalEventName, extractRepoName } from './events.js';

describe('canonicalEventName', () => {
    it('joins header event and body action', () => {
        expect(canonicalEventName('issues', 'opened')).toBe('issues.opened');
    });

    it('returns just header event when no action', () => {
        expect(canonicalEventName('push')).toBe('push');
        expect(canonicalEventName('push', undefined)).toBe('push');
    });

    it('handles pull_request events', () => {
        expect(canonicalEventName('pull_request', 'opened')).toBe('pull_request.opened');
        expect(canonicalEventName('pull_request', 'closed')).toBe('pull_request.closed');
        expect(canonicalEventName('pull_request', 'synchronize')).toBe('pull_request.synchronize');
    });

    it('handles review events', () => {
        expect(canonicalEventName('pull_request_review', 'submitted')).toBe('pull_request_review.submitted');
    });

    it('handles issue_comment events', () => {
        expect(canonicalEventName('issue_comment', 'created')).toBe('issue_comment.created');
    });
});

describe('extractRepoName', () => {
    it('extracts full_name from repository', () => {
        const payload = {
            repository: { full_name: 'org/my-repo', id: 12345 },
        };
        expect(extractRepoName(payload)).toBe('org/my-repo');
    });

    it('returns undefined when no repository', () => {
        expect(extractRepoName({})).toBeUndefined();
    });

    it('returns undefined when repository is missing full_name', () => {
        const payload = { repository: { id: 12345 } };
        expect(extractRepoName(payload)).toBeUndefined();
    });
});
