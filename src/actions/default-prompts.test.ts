import { describe, it, expect } from 'vitest';
import { getDefaultPrompt, listDefaultPromptSources } from './default-prompts.js';
import { generateCodeReviewPrompt } from './review-templates.js';

// The visual editor's "Load default" button hits this registry through
// `GET /api/ai/defaults/:source`. The contract: the text returned here
// must be byte-identical to what `ai-review.ts` falls back to when the
// `prompt` port is left blank — otherwise the "default" the user loads
// in the modal is a lie.

describe('default-prompts registry', () => {
    it('returns the live ai.review system prompt for "ai-review-system-prompt"', () => {
        const text = getDefaultPrompt('ai-review-system-prompt');
        expect(text).not.toBeNull();
        // Same call ai-review.ts makes at module load.
        expect(text).toBe(generateCodeReviewPrompt());
    });

    it('returns null for an unknown source instead of throwing', () => {
        expect(getDefaultPrompt('does-not-exist')).toBeNull();
    });

    it('listDefaultPromptSources advertises the registered keys', () => {
        const sources = listDefaultPromptSources();
        expect(sources).toContain('ai-review-system-prompt');
    });
});
