/**
 * Format an abort-error message that surfaces *why* a workflow was
 * aborted, rather than the bare "Workflow aborted" the runtime used to
 * throw. The queue passes a reason to `AbortController.abort(reason)`:
 *
 *   - `{ kind: 'timeout', timeoutSec }` — per-job timeout fired
 *   - `'cancelled'`                     — explicit user cancel / dedup
 *   - `'shutdown'`                      — engine is shutting down
 *
 * Older callers may pass an Error (from `AbortSignal.timeout()` etc.) or
 * nothing (`signal.aborted` flipped without an explicit reason); both
 * fall back to the generic message so downstream tests and dashboards
 * never see "[object Object]" or "DOMException".
 *
 * Pure function so every abort-throw site (graph runtime, git helpers,
 * wait-for-checks polling) can produce a consistent message that tells
 * the user which knob to turn — e.g. a 5-minute Kimi-via-opencode
 * review surfaces "Workflow timed out after 300s" instead of leaving
 * the user wondering if their provider config is wrong.
 */
export function formatAbortError(reason: unknown): string {
    if (reason && typeof reason === 'object' && 'kind' in reason) {
        const r = reason as { kind: unknown; timeoutSec?: unknown };
        if (r.kind === 'timeout' && typeof r.timeoutSec === 'number') {
            return `Workflow timed out after ${r.timeoutSec}s (raise queue.defaults.timeout or queue.per_workflow.<name>.timeout in sokuza.config.yaml)`;
        }
    }
    if (reason === 'cancelled') return 'Workflow cancelled';
    if (reason === 'shutdown') return 'Workflow aborted (engine shutdown)';
    return 'Workflow aborted';
}

/** Convenience: build an Error directly from a signal's `.reason`. */
export function abortErrorFromSignal(signal: AbortSignal | undefined): Error {
    return new Error(formatAbortError(signal?.reason));
}
