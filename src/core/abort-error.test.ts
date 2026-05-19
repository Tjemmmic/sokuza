import { describe, it, expect } from 'vitest';
import { formatAbortError, abortErrorFromSignal } from './abort-error.js';

// The queue passes typed reasons to AbortController.abort() so the
// runtime can surface a useful message at the user-visible layer:
// "Workflow timed out after 300s" tells the user to bump the timeout;
// "Workflow cancelled" tells them their click landed. The bare
// "Workflow aborted" the runtime used to throw never distinguished
// the two — and a 5-minute ai.review CLI call timing out looked
// identical to a manual cancel.

describe('formatAbortError', () => {
    it('expands a queue timeout reason into actionable text mentioning the elapsed seconds and the config knob', () => {
        const msg = formatAbortError({ kind: 'timeout', timeoutSec: 300 });
        expect(msg).toContain('timed out');
        expect(msg).toContain('300s');
        // Mentions the knob to turn so the user knows where to look.
        expect(msg).toMatch(/queue\.(defaults|per_workflow)/);
    });

    it('distinguishes a manual cancel from a timeout', () => {
        expect(formatAbortError('cancelled')).toBe('Workflow cancelled');
    });

    it('labels engine shutdown distinctly', () => {
        expect(formatAbortError('shutdown')).toBe('Workflow aborted (engine shutdown)');
    });

    it('falls back to the generic message for unknown reasons (older callers, native AbortSignal.timeout DOMException, etc.)', () => {
        expect(formatAbortError(undefined)).toBe('Workflow aborted');
        expect(formatAbortError(null)).toBe('Workflow aborted');
        expect(formatAbortError(new Error('something'))).toBe('Workflow aborted');
        expect(formatAbortError({ kind: 'unrecognised' })).toBe('Workflow aborted');
        // Missing timeoutSec → can't print "Xs", so fall back rather
        // than produce a half-formed sentence.
        expect(formatAbortError({ kind: 'timeout' })).toBe('Workflow aborted');
    });

    it('abortErrorFromSignal reads the reason off a real AbortSignal', () => {
        const ac = new AbortController();
        ac.abort({ kind: 'timeout', timeoutSec: 60 });
        const err = abortErrorFromSignal(ac.signal);
        expect(err.message).toContain('60s');
    });

    it('abortErrorFromSignal handles a missing signal (some callsites pass undefined)', () => {
        expect(abortErrorFromSignal(undefined).message).toBe('Workflow aborted');
    });
});
