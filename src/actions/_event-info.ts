import type { EventPayload } from '../core/types.js';
import type { AiReviewRunRecord } from '../core/run-store.js';

/**
 * Extract the subset of an event that AI-action run records persist:
 * source / event / repo / prNumber / branch.
 *
 * Used by `ai-review` and `ai-agent` (parse_as_review path) so the
 * on-disk shape stays consistent and the `address-review` loop reads
 * the same fields regardless of which producer wrote the record.
 *
 * Underscore-prefixed file name marks this as a within-actions helper
 * — not for callers outside `src/actions/`.
 */
export function extractEventInfo(event: EventPayload): AiReviewRunRecord['event'] {
    const meta = event.metadata ?? {};
    const pr = event.payload?.pull_request as Record<string, unknown> | undefined;
    const info: AiReviewRunRecord['event'] = {
        source: event.source,
        event: event.event,
    };
    const repo = meta.repo as string | undefined;
    if (repo) info.repo = repo;
    const prNumber = (meta.prNumber ?? pr?.number) as number | undefined;
    if (typeof prNumber === 'number') info.prNumber = prNumber;
    const branch = (pr?.head as Record<string, unknown> | undefined)?.ref as string | undefined;
    if (branch) info.branch = branch;
    return info;
}
