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

// When ai.agent is set to parse_as_review=true it must emit the same output
// ports as ai.review so downstream nodes (`github.create-review` interpolating
// `{{nodes.X.markdown}}` + `{{nodes.X.runId}}`) work without any rewiring.
// Pin both the config port and the output ports.

describe('ai.agent exposes the parse_as_review surface for the auto-fix loop', () => {
    let registry: NodeRegistry;

    beforeEach(() => {
        registry = new NodeRegistry();
        registerBuiltinNodes(registry);
    });

    it('declares a parse_as_review config switch', () => {
        const def = registry.serialize().find((n) => n.type === 'ai.agent');
        expect(def, 'ai.agent should be registered').toBeDefined();
        const flag = def!.ports.find((p) => p.name === 'parse_as_review' && p.role === 'input');
        expect(flag, 'ai.agent missing parse_as_review port').toBeDefined();
        expect(flag?.config).toBe(true);
        expect(flag?.control).toBe('switch');
        expect(flag?.type).toBe('boolean');
    });

    // Same names as ai.review so existing graphs can swap one for the other.
    const REVIEW_OUTPUTS = ['markdown', 'structured', 'summary', 'issues', 'mergeReady', 'runId'];

    for (const portName of REVIEW_OUTPUTS) {
        it(`declares output port "${portName}" so wires resolve at design time`, () => {
            const def = registry.serialize().find((n) => n.type === 'ai.agent');
            const port = def!.ports.find((p) => p.name === portName && p.role === 'output');
            expect(port, `ai.agent missing review output port "${portName}"`).toBeDefined();
            expect(port?.wire).toBe(true);
        });
    }
});

// utility.shell-exec must expose stable port names so library workflows
// (clone repo → run tests → branch on success) can wire to them without
// hand-debugging "why is `success` undefined?"

describe('utility.shell-exec exposes the documented input + output ports', () => {
    let registry: NodeRegistry;

    beforeEach(() => {
        registry = new NodeRegistry();
        registerBuiltinNodes(registry);
    });

    const INPUT_PORTS = ['workdir', 'command', 'args', 'timeout_seconds', 'max_output_bytes', 'env'];
    const OUTPUT_PORTS = ['stdout', 'stderr', 'exitCode', 'success', 'timedOut', 'truncated', 'durationMs'];

    it('declares every documented input port as config-true', () => {
        const def = registry.serialize().find((n) => n.type === 'utility.shell-exec');
        expect(def, 'utility.shell-exec should be registered').toBeDefined();
        for (const portName of INPUT_PORTS) {
            const port = def!.ports.find((p) => p.name === portName && p.role === 'input');
            expect(port, `utility.shell-exec missing input port "${portName}"`).toBeDefined();
            expect(port?.config).toBe(true);
        }
    });

    it('declares every documented output port as wire-able', () => {
        const def = registry.serialize().find((n) => n.type === 'utility.shell-exec');
        for (const portName of OUTPUT_PORTS) {
            const port = def!.ports.find((p) => p.name === portName && p.role === 'output');
            expect(port, `utility.shell-exec missing output port "${portName}"`).toBeDefined();
            expect(port?.wire).toBe(true);
        }
    });

    it('marks workdir and command as required (the two un-defaulted inputs)', () => {
        const def = registry.serialize().find((n) => n.type === 'utility.shell-exec');
        const workdir = def!.ports.find((p) => p.name === 'workdir');
        const command = def!.ports.find((p) => p.name === 'command');
        expect(workdir?.required).toBe(true);
        expect(command?.required).toBe(true);
    });
});

// All three GitHub-flavored trigger nodes must expose the same filter ports
// — including the exclude/negation axes. Without this pin a poll/cli node
// can silently regress to only `events`/`repos` (the original shape),
// leaving the user unable to limit by author/branch/label in the editor.
describe('GitHub trigger nodes expose symmetric include + exclude ports', () => {
    let registry: NodeRegistry;

    beforeEach(() => {
        registry = new NodeRegistry();
        registerBuiltinNodes(registry);
    });

    const INCLUDE_PORTS = ['repos', 'branches', 'authors', 'labels'];
    const EXCLUDE_PORTS = [
        'exclude_repos',
        'exclude_branches',
        'exclude_authors',
        'exclude_labels',
    ];

    for (const type of ['trigger.github', 'trigger.github-poll', 'trigger.gh-cli']) {
        it(`${type} exposes every include filter port`, () => {
            const def = registry.serialize().find((n) => n.type === type);
            expect(def, `${type} should be registered`).toBeDefined();
            for (const portName of INCLUDE_PORTS) {
                const port = def!.ports.find((p) => p.name === portName && p.role === 'input');
                expect(port, `${type} missing include port "${portName}"`).toBeDefined();
                expect(port?.config).toBe(true);
            }
        });

        it(`${type} exposes every exclude filter port`, () => {
            const def = registry.serialize().find((n) => n.type === type);
            for (const portName of EXCLUDE_PORTS) {
                const port = def!.ports.find((p) => p.name === portName && p.role === 'input');
                expect(port, `${type} missing exclude port "${portName}"`).toBeDefined();
                expect(port?.config).toBe(true);
            }
        });
    }
});
