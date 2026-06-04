/**
 * CLI arg-layout styles for `kind: cli` AI providers.
 *
 * Kept in a tiny, dependency-free module so both the provider system
 * (`ai-providers.ts`) and the API server's validation (`server/api.ts`)
 * can import the single source of truth — without the API server pulling
 * in the heavy `ai-providers` module (which loads the Anthropic SDK).
 */
export type ArgsStyle = 'claude-code' | 'opencode' | 'gemini' | 'codex';

/** Every valid `args_style`. Single source of truth for validation. */
export const ARGS_STYLES: readonly ArgsStyle[] = ['claude-code', 'opencode', 'gemini', 'codex'];
