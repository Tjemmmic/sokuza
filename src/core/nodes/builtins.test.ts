import { describe, it, expect, beforeEach } from 'vitest';
import { wrapResult, registerBuiltinNodes } from './builtins.js';
import { NodeRegistry } from './registry.js';

// Pins the documented action-node output contract: every handler key becomes
// a port, plus a synthetic `result` port carrying the whole return value.
// The synthetic `result` deliberately wins over a handler key of the same
// name so graph chaining can rely on `{{nodes.X.result}}` always meaning
// "X's full output". See wrapResult's doc comment.

describe('wrapResult', () => {
    it('spreads object keys and adds a synthetic result port', () => {
        const handlerReturn = { url: 'https://x', number: 42 };
        const out = wrapResult(handlerReturn);
        expect(out.url).toBe('https://x');
        expect(out.number).toBe(42);
        expect(out.result).toBe(handlerReturn);
    });

    it('wraps scalars and arrays under the result key only', () => {
        expect(wrapResult('done')).toEqual({ result: 'done' });
        expect(wrapResult(0)).toEqual({ result: 0 });
        expect(wrapResult(false)).toEqual({ result: false });
        expect(wrapResult(null)).toEqual({ result: null });
        expect(wrapResult(undefined)).toEqual({ result: undefined });
        const arr = [1, 2, 3];
        expect(wrapResult(arr)).toEqual({ result: arr });
    });

    it('synthetic result intentionally shadows a handler-returned result key', () => {
        // Regression guard for the deliberate precedence: chaining must keep
        // meaning "the whole bag", and the original is still reachable nested.
        const handlerReturn = { result: 'partial', count: 5 };
        const out = wrapResult(handlerReturn);
        expect(out.count).toBe(5);
        expect(out.result).toBe(handlerReturn); // whole object, not 'partial'
        expect((out.result as { result: unknown }).result).toBe('partial');
    });

    it('does not mutate the handler return value', () => {
        const handlerReturn = { a: 1 };
        wrapResult(handlerReturn);
        expect(handlerReturn).toEqual({ a: 1 });
        expect('result' in handlerReturn).toBe(false);
    });
});

// AI node ports drive the visual editor's provider/model selects. The
// dashboard renders these as proper dropdowns only when the port's
// `control` field arrives as 'ai-provider' / 'ai-model' through
// /api/nodes. Pin the contract so a builtins.ts refactor can't silently
// regress all three AI nodes back to blank text boxes.

describe('AI nodes expose typed AI provider/model controls', () => {
    let registry: NodeRegistry;

    beforeEach(() => {
        registry = new NodeRegistry();
        registerBuiltinNodes(registry);
    });

    for (const type of ['ai.review', 'ai.agent', 'ai.address-review']) {
        it(`${type} provider port uses 'ai-provider' control`, () => {
            const def = registry.serialize().find((n) => n.type === type);
            expect(def, `${type} should be registered`).toBeDefined();
            const providerPort = def!.ports.find((p) => p.name === 'provider' && p.role === 'input');
            expect(providerPort?.control).toBe('ai-provider');
        });

        it(`${type} model port uses 'ai-model' control`, () => {
            const def = registry.serialize().find((n) => n.type === type);
            const modelPort = def!.ports.find((p) => p.name === 'model' && p.role === 'input');
            expect(modelPort?.control).toBe('ai-model');
        });
    }

    it('ai.review prompt port advertises the default-prompt source so the modal can offer "Load default"', () => {
        const def = registry.serialize().find((n) => n.type === 'ai.review');
        const promptPort = def!.ports.find((p) => p.name === 'prompt' && p.role === 'input');
        expect(promptPort?.control).toBe('textarea');
        expect(promptPort?.defaultSource).toBe('ai-review-system-prompt');
    });
});
