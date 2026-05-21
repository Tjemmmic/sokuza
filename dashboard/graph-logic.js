// ─── Sokuza Visual Editor — pure graph logic ────────────────────────────────
//
// Port resolution and event-glob matching, factored out of graph-editor.js so
// they can be unit-tested in isolation and parity-checked against the runtime.
//
// KEEP IN SYNC WITH src/core/nodes/types.ts:
//   - resolveWireableOutputPorts  mirrors  resolveOutputPorts
//   - eventGlobMatch              mirrors  matchEventGlob
//   - portTypeForInputType        mirrors  portTypeForInputType
// src/__tests__/graph-editor-logic.test.ts asserts this parity; if you change
// the runtime side, that test fails until this file is updated to match.
//
// No bundler — this loads as a plain <script> in the browser (attaching to
// window.graphLogic) and as a CommonJS module under vitest.

(function (factory) {
    'use strict';
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;            // vitest / Node (CommonJS)
    } else if (typeof window !== 'undefined') {
        window.graphLogic = api;         // dashboard <script>
    } else if (typeof globalThis !== 'undefined') {
        globalThis.graphLogic = api;
    }
})(function () {
    'use strict';

    // Coerce a config value to an array the way graph-editor.js's ensureArr
    // does (null → [], non-array → [v]). The runtime's resolveOutputPorts
    // only treats already-array configs as event lists; for the values the
    // editor actually produces (string[] from a multiselect) the two agree.
    function toArr(v) {
        if (v == null) return [];
        return Array.isArray(v) ? v : [v];
    }

    /** "pull_request.*" matches "pull_request.opened" / "pull_request.closed". */
    function eventGlobMatch(pattern, value) {
        if (pattern === value) return true;
        if (!pattern.includes('*')) return false;
        const re = new RegExp(
            '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
        );
        return re.test(value);
    }

    function portTypeForInputType(t) {
        return ({
            'github-pr': 'pr',
            'github-issue': 'issue',
            number: 'number',
            boolean: 'boolean',
            'github-branch': 'string',
            'github-repo': 'string',
            text: 'string', textarea: 'string', select: 'string',
        })[t] || 'string';
    }

    /**
     * Wire-able output ports for a node: the declared outputs plus any
     * config-driven dynamic ones. Excludes outputs flagged `wire: false`
     * since the editor only draws handles for ports the user can connect.
     */
    function resolveWireableOutputPorts(def, node) {
        const out = def.ports.filter((p) => p.role === 'output' && p.wire !== false);
        if (!def.dynamicOutputs) return out;
        const seen = new Set(out.map((p) => p.name));
        for (const spec of def.dynamicOutputs) {
            if (spec.kind === 'per-input') {
                const list = node.config?.[spec.inputsConfigKey];
                if (!Array.isArray(list)) continue;
                for (const item of list) {
                    if (!item || !item.name || seen.has(item.name)) continue;
                    seen.add(item.name);
                    out.push({
                        name: item.name,
                        label: item.label || item.name,
                        role: 'output',
                        wire: true,
                        type: portTypeForInputType(item.type),
                        helpText: `User-defined input: ${item.name}`,
                    });
                }
            } else if (spec.kind === 'event-conditional') {
                const events = toArr(node.config?.[spec.eventsConfigKey]);
                for (const rule of spec.rules) {
                    const matches = rule.whenEvents.some((we) => events.some((e) => eventGlobMatch(we, e)));
                    if (!matches) continue;
                    for (const p of rule.ports) {
                        if (seen.has(p.name)) continue;
                        seen.add(p.name);
                        out.push(p);
                    }
                }
            } else if (spec.kind === 'per-config-value') {
                // kv map → one port per unique value. Mirrors the runtime
                // resolver in src/core/nodes/types.ts.
                const map = node.config?.[spec.configKey];
                if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
                for (const value of Object.values(map)) {
                    if (typeof value !== 'string' || !value || seen.has(value)) continue;
                    seen.add(value);
                    out.push({
                        name: value,
                        label: value,
                        role: 'output',
                        wire: true,
                        type: spec.portType || 'any',
                        helpText: `${spec.helpTextPrefix || 'Case branch'}: ${value}`,
                    });
                }
            }
        }
        return out;
    }

    return { eventGlobMatch, portTypeForInputType, resolveWireableOutputPorts };
});
