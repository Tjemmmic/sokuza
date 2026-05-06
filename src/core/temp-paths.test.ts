import { describe, it, expect } from 'vitest';
import { WORKFLOW_TEMP_PREFIX, isWorkflowTempPath } from './temp-paths.js';

describe('temp-paths', () => {
    it('exposes a non-empty prefix that callers (clone-repo, etc.) can reuse', () => {
        // The runtime cleanup pass keys off this constant. If anyone
        // changes the prefix without updating callers, leaking temp dirs
        // is the consequence — pin the value so the change shows up in
        // a diff review.
        expect(WORKFLOW_TEMP_PREFIX).toBe('sokuza-repo-');
        expect(WORKFLOW_TEMP_PREFIX.length).toBeGreaterThan(0);
    });

    it('matches paths created with the canonical prefix', () => {
        expect(isWorkflowTempPath(`/tmp/${WORKFLOW_TEMP_PREFIX}abc123`)).toBe(true);
        expect(isWorkflowTempPath(`/var/folders/x/${WORKFLOW_TEMP_PREFIX}xyz`)).toBe(true);
    });

    it('rejects paths from other tools / user-owned dirs (no false positives)', () => {
        expect(isWorkflowTempPath('/tmp/some-other-tool-abc')).toBe(false);
        expect(isWorkflowTempPath('/home/user/persistent/workdir')).toBe(false);
        expect(isWorkflowTempPath('')).toBe(false);
    });
});
