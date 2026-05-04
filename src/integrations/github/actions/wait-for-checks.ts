import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { resolveRepoTarget, requireToken } from './_target.js';

const DEFAULT_TIMEOUT_S = 600; // 10 min — long enough for typical CI
const DEFAULT_INTERVAL_S = 15;

/**
 * "github-wait-for-checks" — poll commit checks (both Checks API
 * runs and the legacy combined status) until they're all complete or
 * the timeout fires. A check is "complete" when its `conclusion` is
 * set (success/failure/skipped/etc.). Pending/in-progress runs keep
 * polling.
 *
 * The handler resolves the SHA from (in order):
 *   1. params.sha
 *   2. params.head_sha
 *   3. event.payload.pull_request.head.sha
 *   4. — fail with a clear message
 *
 * Output `success` is true only when every observed check concluded
 * with success/skipped/neutral; otherwise it's false and the failing
 * check names land in `failedChecks`.
 */
export const githubWaitForChecksAction: ActionHandler = async (params, context) => {
    const token = requireToken(params, context, 'github-wait-for-checks');
    const target = resolveRepoTarget(params, context, 'github-wait-for-checks');

    const sha = resolveSha(params, context);
    if (!sha) {
        throw new Error('github-wait-for-checks: no commit SHA found (params.sha, head_sha, or event payload pull_request.head.sha)');
    }

    const timeoutSec = (params.timeout as number) ?? DEFAULT_TIMEOUT_S;
    const intervalSec = (params.interval as number) ?? DEFAULT_INTERVAL_S;
    const client = new GitHubApiClient(token);

    const deadline = Date.now() + timeoutSec * 1000;
    let lastSnapshot: { totalChecks: number; pending: number; failed: string[] } = {
        totalChecks: 0, pending: 0, failed: [],
    };

    while (Date.now() < deadline) {
        const runs = await client.getCheckRuns(target.owner, target.repo, sha);
        const failed: string[] = [];
        let pending = 0;
        for (const run of runs) {
            const status = String((run as { status?: unknown }).status ?? '');
            const conclusion = String((run as { conclusion?: unknown }).conclusion ?? '');
            const name = String((run as { name?: unknown }).name ?? '');
            if (status !== 'completed') {
                pending++;
                continue;
            }
            if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled' || conclusion === 'action_required') {
                failed.push(name);
            }
        }
        lastSnapshot = { totalChecks: runs.length, pending, failed };

        // Also fold in the legacy combined status so non-checks-API CIs count.
        const combined = await client.getCombinedStatus(target.owner, target.repo, sha);
        const state = String((combined as { state?: unknown }).state ?? '');
        const statuses = Array.isArray((combined as { statuses?: unknown }).statuses)
            ? (combined as { statuses: Array<Record<string, unknown>> }).statuses
            : [];
        for (const s of statuses) {
            const sState = String(s.state ?? '');
            if (sState === 'pending') pending++;
            else if (sState === 'failure' || sState === 'error') failed.push(String(s.context ?? 'status'));
        }
        lastSnapshot.totalChecks += statuses.length;

        if (pending === 0) {
            return {
                success: failed.length === 0 && (state === '' || state === 'success' || state === 'pending'),
                failedChecks: failed,
                totalChecks: lastSnapshot.totalChecks,
                sha,
                timedOut: false,
            };
        }

        context.logger.info(
            { sha, pending, failed: failed.length, total: lastSnapshot.totalChecks },
            'Checks still running, will retry',
        );
        await sleep(intervalSec * 1000);
    }

    return {
        success: false,
        failedChecks: lastSnapshot.failed,
        totalChecks: lastSnapshot.totalChecks,
        sha,
        timedOut: true,
    };
};

function resolveSha(params: Parameters<ActionHandler>[0], context: Parameters<ActionHandler>[1]): string {
    if (typeof params.sha === 'string' && params.sha) return params.sha;
    if (typeof params.head_sha === 'string' && params.head_sha) return params.head_sha;
    const payload = context.event.payload as Record<string, unknown> | undefined;
    const pr = payload?.pull_request as Record<string, unknown> | undefined;
    const head = pr?.head as Record<string, unknown> | undefined;
    return typeof head?.sha === 'string' ? head.sha : '';
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
