/**
 * Registry of named default prompts the visual editor can surface as
 * "Load default" affordances on action node config ports.
 *
 * Each entry is a function that returns the current default text (not a
 * static string) so callers always see the prompt the action would
 * actually use today, even if we tweak `review-templates.ts` later. The
 * key is whatever the node port declares as `defaultSource`.
 *
 * Add a new entry here whenever an action has a hardcoded default prompt
 * the user might want to view or customise — keep the registry small;
 * fields with truly arbitrary defaults belong in the action's own param
 * docs instead.
 */
import { generateCodeReviewPrompt } from './review-templates.js';

const DEFAULTS: Record<string, () => string> = {
    'ai-review-system-prompt': () => generateCodeReviewPrompt(),
};

export function getDefaultPrompt(source: string): string | null {
    const factory = DEFAULTS[source];
    return factory ? factory() : null;
}

export function listDefaultPromptSources(): string[] {
    return Object.keys(DEFAULTS);
}
