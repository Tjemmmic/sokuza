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

    it('rejects user-owned paths that merely contain the prefix mid-segment', () => {
        // The previous substring match would schedule these for rm -rf.
        // The anchored regex requires the prefix to start a path segment
        // and end with mkdtemp's random alphanumeric suffix, so a user
        // directory like `/home/u/old-sokuza-repo-backup/data` no longer
        // qualifies even though it contains the literal substring.
        expect(isWorkflowTempPath('/home/u/old-sokuza-repo-backup/data')).toBe(false);
        expect(isWorkflowTempPath('/var/sokuza-repo-archived.tar.gz')).toBe(false);
        // Lacks the random suffix entirely — not from mkdtemp.
        expect(isWorkflowTempPath('/tmp/sokuza-repo-')).toBe(false);
    });

    it('matches mkdtemp output even when nested under further path segments', () => {
        // mkdtemp returns the leaf temp dir, but actions sometimes
        // re-emit subpaths (e.g. /tmp/sokuza-repo-aB3kZ9/.git). Both
        // shapes should still match.
        expect(isWorkflowTempPath('/tmp/sokuza-repo-aB3kZ9')).toBe(true);
        expect(isWorkflowTempPath('/tmp/sokuza-repo-aB3kZ9/.git/HEAD')).toBe(true);
    });
});
