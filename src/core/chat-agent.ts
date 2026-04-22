/**
 * Chat agent — the tool-use loop that drives a session forward.
 *
 * Shape of one user turn:
 *
 *   1. Append the user's message to the session's JSONL log.
 *   2. Call the Anthropic API with:
 *        - tools:     CHAT_TOOL_DEFINITIONS
 *        - system:    seed context + short instructions
 *        - messages:  the full log, role-mapped to the Messages API
 *   3. Iterate:
 *        - `text` blocks        → append assistant turn, emit, stop loop
 *        - `tool_use` blocks    → dispatch tool, append tool result,
 *                                  continue loop (next iter feeds the
 *                                  result back to the model)
 *   4. Iteration cap: 10 tool rounds per user turn (guards against
 *      runaway loops if the model keeps asking for tools without
 *      producing final text).
 *
 * Only `anthropic-api` providers are supported in MVP — the SDK gives
 * us `tools` natively. Other provider kinds throw a clear error at
 * session-create time (see routes) so this agent never sees them.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { ChatMessage, ChatSession, ChatToolCall } from './types.js';
import type { SokuzaEngine } from './engine.js';
import type { AIProvider } from './ai-providers.js';
import { CHAT_TOOL_DEFINITIONS, dispatchChatTool, type ChatToolContext } from './chat-tools.js';
import { ChatStore } from './chat-store.js';

const MAX_TOOL_ITERATIONS = 10;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Events emitted by `runChatTurn` to a subscriber (the SSE handler in
 * `api.ts` is the only caller). Each event corresponds 1:1 with a
 * ChatMessage that was persisted, so the dashboard just renders these
 * as they arrive.
 */
export type ChatEvent =
    | { type: 'assistant_text'; message: ChatMessage }
    | { type: 'tool_call'; message: ChatMessage }
    | { type: 'tool_result'; message: ChatMessage }
    | { type: 'error'; error: string }
    | { type: 'done' };

export type ChatEventEmitter = (event: ChatEvent) => void;

export interface RunChatTurnParams {
    session: ChatSession;
    userMessage: string;
    engine: SokuzaEngine;
    logger: Logger;
    emit: ChatEventEmitter;
    /**
     * ChatStore to persist turns to. Required — both the HTTP handler
     * and the tests own the store instance, so we take it as input
     * instead of reconstructing one with the default home-dir path
     * (which would hide test data and split stores in process).
     */
    store: ChatStore;
}

/**
 * Execute one user turn end-to-end. Emits events as it progresses so
 * the caller (SSE handler) can stream them to the browser. Resolves
 * after the final assistant text is persisted; errors are emitted via
 * `{ type: 'error' }` rather than thrown so the SSE connection stays
 * attached for the client to close cleanly.
 */
export async function runChatTurn(params: RunChatTurnParams): Promise<void> {
    const { session, userMessage, engine, logger, emit, store } = params;

    // Resolve the provider for this session. Sessions pin a provider at
    // creation time; we re-resolve every turn so config edits (e.g. the
    // user rotating their ZAI key) take effect without restarting the
    // session.
    const registry = engine.getConfig().ai;
    if (!registry) {
        emit({ type: 'error', error: 'AI provider registry is not configured.' });
        emit({ type: 'done' });
        return;
    }
    const provider = registry.providers.get(session.provider);
    if (!provider) {
        emit({ type: 'error', error: `Session provider "${session.provider}" is not registered.` });
        emit({ type: 'done' });
        return;
    }
    if (provider.kind !== 'anthropic-api') {
        emit({
            type: 'error',
            error: `Chat requires an anthropic-api provider; session is pinned to "${session.provider}" (kind=${provider.kind}).`,
        });
        emit({ type: 'done' });
        return;
    }
    if (!provider.apiKey) {
        emit({
            type: 'error',
            error: `Provider "${session.provider}" is missing an api_key. Configure it in the dashboard.`,
        });
        emit({ type: 'done' });
        return;
    }

    // Persist the user's turn first. If anything fails after this, the
    // log still reflects what was asked — useful for debugging and UX
    // continuity.
    const userMsg = await store.appendMessage(session.id, {
        role: 'user',
        content: userMessage,
    });
    logger.debug({ sessionId: session.id, messageId: userMsg.id }, 'User message appended');

    const client = new Anthropic({
        apiKey: provider.apiKey,
        ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
    });

    const toolCtx: ChatToolContext = { session, engine, logger, store };
    const model = provider.defaultModel;
    if (!model) {
        emit({ type: 'error', error: `Provider "${session.provider}" has no default model.` });
        emit({ type: 'done' });
        return;
    }

    try {
        // The agent loop: we mutate `apiMessages` locally so each
        // iteration sends the growing conversation to the model. We
        // *also* append to the persistent log via chat-store so the
        // next turn (or a page reload) can replay it.
        const apiMessages = await buildApiMessages(store, session.id);

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
            const response = await client.messages.create({
                model,
                max_tokens: DEFAULT_MAX_TOKENS,
                system: buildSystemPrompt(session),
                tools: CHAT_TOOL_DEFINITIONS,
                // Spread to hand the SDK a copy scoped to this iteration —
                // we keep mutating `apiMessages` as the loop progresses,
                // and we don't want downstream code (SDK retries, tests'
                // mock `mock.calls` capture-by-reference) to observe a
                // shifting target.
                messages: [...apiMessages],
            });

            // Split response content into text parts and tool_use parts.
            const textParts = response.content.filter(
                (b): b is Anthropic.TextBlock => b.type === 'text',
            );
            const toolUses = response.content.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            );

            // Mirror the assistant's full content back into `apiMessages`
            // so that if we continue the loop, the tool_result `user`
            // turn we append next references tool_use ids the model
            // actually emitted.
            apiMessages.push({ role: 'assistant', content: response.content });

            // If the model produced any text alongside the tool calls,
            // persist + emit each text block as its own assistant message
            // — helps the UI render "thinking out loud" before tool calls.
            for (const t of textParts) {
                if (!t.text.trim()) continue;
                const persisted = await store.appendMessage(session.id, {
                    role: 'assistant',
                    content: t.text,
                });
                emit({ type: 'assistant_text', message: persisted });
            }

            // No tool calls → the turn is complete.
            if (toolUses.length === 0) {
                emit({ type: 'done' });
                return;
            }

            // Dispatch each tool call in order, emit a tool_call event
            // before and a tool_result event after. We persist both the
            // call and the result so the log faithfully represents what
            // happened.
            const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
            for (const tu of toolUses) {
                const call: ChatToolCall = {
                    id: tu.id,
                    name: tu.name,
                    input: (tu.input ?? {}) as Record<string, unknown>,
                };
                const callMsg = await store.appendMessage(session.id, {
                    role: 'assistant',
                    content: '',
                    toolCall: call,
                });
                emit({ type: 'tool_call', message: callMsg });

                const result = await dispatchChatTool(tu.name, call.input, toolCtx);

                const resultMsg = await store.appendMessage(session.id, {
                    role: 'tool',
                    content: result.content,
                    toolResult: {
                        callId: tu.id,
                        output: result.content,
                        isError: result.isError,
                    },
                });
                emit({ type: 'tool_result', message: resultMsg });

                toolResultBlocks.push({
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: truncateForModel(result.content),
                    is_error: result.isError || undefined,
                });
            }

            // Feed all tool results back in a single user turn — the
            // Messages API batches them that way.
            apiMessages.push({ role: 'user', content: toolResultBlocks });
        }

        // Iteration cap reached without a final text response.
        const exhaustion = `Reached the ${MAX_TOOL_ITERATIONS}-tool-iteration cap for this turn. Ask a narrower follow-up question to continue.`;
        const persisted = await store.appendMessage(session.id, {
            role: 'assistant',
            content: exhaustion,
        });
        emit({ type: 'assistant_text', message: persisted });
        emit({ type: 'done' });
    } catch (e: any) {
        // Typed Anthropic errors (rate-limit, auth, etc.) land here
        // along with anything else. We don't try to classify — just
        // surface the message so the model's mistakes show up in the
        // chat and the UI can flag them.
        const errMsg = formatAgentError(e, provider);
        logger.warn({ sessionId: session.id, err: errMsg }, 'Chat agent turn failed');
        emit({ type: 'error', error: errMsg });
        emit({ type: 'done' });
    }
}

/**
 * Map the persisted JSONL log into the shape the Messages API expects.
 *
 * - System messages are NOT emitted here; they become part of the
 *   top-level `system` param. We fold session seed context into that
 *   block instead (see `buildSystemPrompt`).
 * - Assistant turns that only carry a `toolCall` (no text) become an
 *   `assistant` message with a single `tool_use` block.
 * - Tool-role turns become `user` messages with a `tool_result` block,
 *   matching the API's convention.
 * - Plain text assistant/user turns pass through with string content.
 *
 * We don't attempt to preserve the model's original `content` array
 * verbatim — we reconstruct just enough to let the model continue
 * coherently. This is simpler and keeps the JSONL log human-readable.
 */
async function buildApiMessages(store: ChatStore, sessionId: string): Promise<Anthropic.MessageParam[]> {
    const messages = await store.getMessages(sessionId);
    const out: Anthropic.MessageParam[] = [];

    // Walk messages in order. Merge consecutive tool-role messages into
    // a single `user` turn with multiple `tool_result` blocks (required
    // by the API).
    let i = 0;
    while (i < messages.length) {
        const m = messages[i];
        if (m.role === 'system') { i++; continue; }

        if (m.role === 'user') {
            out.push({ role: 'user', content: m.content });
            i++;
            continue;
        }

        if (m.role === 'assistant') {
            // Aggregate contiguous assistant messages — may be mix of text
            // and tool_use — into one assistant turn, matching the model's
            // original shape.
            const blocks: Anthropic.ContentBlockParam[] = [];
            while (i < messages.length && messages[i].role === 'assistant') {
                const am = messages[i];
                if (am.toolCall) {
                    blocks.push({
                        type: 'tool_use',
                        id: am.toolCall.id,
                        name: am.toolCall.name,
                        input: am.toolCall.input as Anthropic.ToolUseBlock['input'],
                    });
                } else if (am.content.trim()) {
                    blocks.push({ type: 'text', text: am.content });
                }
                i++;
            }
            if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
            continue;
        }

        if (m.role === 'tool') {
            const results: Anthropic.ToolResultBlockParam[] = [];
            while (i < messages.length && messages[i].role === 'tool') {
                const tm = messages[i];
                if (tm.toolResult) {
                    results.push({
                        type: 'tool_result',
                        tool_use_id: tm.toolResult.callId,
                        content: truncateForModel(tm.toolResult.output),
                        is_error: tm.toolResult.isError || undefined,
                    });
                }
                i++;
            }
            if (results.length > 0) out.push({ role: 'user', content: results });
            continue;
        }

        i++;
    }

    return out;
}

/**
 * System prompt for every turn. Includes scope info + a short directive
 * on how to use tools. We keep this terse so it caches well and the
 * model doesn't spend tokens re-reading instructions.
 */
function buildSystemPrompt(session: ChatSession): string {
    const scope = session.scope;
    let scopeBlock = '';
    if (scope.kind === 'repo') {
        scopeBlock = `This chat is scoped to repository \`${scope.repo}\`${scope.ref ? ` at ref \`${scope.ref}\`` : ''}.`;
    } else if (scope.kind === 'branch') {
        scopeBlock = `This chat is scoped to branch \`${scope.ref}\` of \`${scope.repo}\`.`;
    } else {
        scopeBlock = `This chat is scoped to pull request #${scope.prNumber} of \`${scope.repo}\` (branch \`${scope.ref}\`)${scope.title ? ` — "${scope.title}"` : ''}${scope.author ? `, opened by ${scope.author}` : ''}.`;
    }

    return [
        'You are a senior engineer helping a developer reason about a specific repo/branch/PR.',
        '',
        scopeBlock,
        '',
        'You have tools for inspecting the repo (read_file, list_files, grep, get_diff) and for triggering configured sokuza workflows (list_workflows, run_workflow). Prefer calling tools over guessing — the workdir is already cloned and ready.',
        '',
        'Style:',
        '- Answer the question, don\'t narrate your process.',
        '- Use inline backticks for identifiers.',
        '- When you run a workflow, relay its output verbatim; don\'t summarize unless asked.',
        '- If a tool errors, tell the user plainly and suggest the next step.',
    ].join('\n');
}

/**
 * Cap tool-result payload size before it's fed back to the model. Some
 * tools (grep, read_file) can return a lot; we've already truncated
 * inside each tool, but this is a belt-and-suspenders cap so a single
 * misbehaving tool can't blow up the token budget.
 */
function truncateForModel(content: string): string {
    const MAX = 16_000;
    if (content.length <= MAX) return content;
    return content.slice(0, MAX) + `\n\n… [truncated ${content.length - MAX} chars for the model]`;
}

function formatAgentError(e: unknown, provider: AIProvider): string {
    if (e instanceof Anthropic.AuthenticationError) {
        return `Authentication failed for provider "${provider.name}". Check the api_key in the dashboard.`;
    }
    if (e instanceof Anthropic.RateLimitError) {
        return `Rate limited by provider "${provider.name}". Wait and retry.`;
    }
    if (e instanceof Anthropic.APIError) {
        return `API error from provider "${provider.name}" (status ${e.status}): ${e.message}`;
    }
    if (e instanceof Error) return e.message;
    return String(e);
}
