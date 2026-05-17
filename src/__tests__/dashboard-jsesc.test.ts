import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// jsEsc lives in app.js, a bundler-less browser file full of DOM globals we
// can't evaluate wholesale. Extract just the pure function and run it in a vm
// — this exercises exactly the bytes the dashboard ships.
function loadJsEsc(): (s: unknown) => string {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../../dashboard/app.js'), 'utf8');
    const m = src.match(/function jsEsc\(s\) \{[\s\S]*?\n\}/);
    if (!m) throw new Error('jsEsc not found in app.js');
    const sandbox: { jsEsc?: (s: unknown) => string } = {};
    vm.runInNewContext(`${m[0]}; this.jsEsc = jsEsc;`, sandbox);
    return sandbox.jsEsc!;
}

const jsEsc = loadJsEsc();

/**
 * Reproduce the browser pipeline for onclick="fn('${jsEsc(x)}')":
 *   1. jsEsc produces the attribute text,
 *   2. the HTML parser decodes entities in the attribute value (single pass),
 *   3. the JS engine parses the resulting source.
 * Returns every argument fn was called with, or throws on a JS parse error.
 */
function roundTrip(input: unknown): unknown[] {
    const escaped = jsEsc(input);
    const htmlEntities: Record<string, string> = {
        '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>',
    };
    const htmlDecoded = escaped.replace(/&(amp|quot|lt|gt);/g, (e) => htmlEntities[e]);

    const calls: unknown[][] = [];
    const sandbox = {
        fn: (...args: unknown[]) => { calls.push(args); },
        // Sentinel: if an injection escapes the string and runs, it would
        // most naturally call fn() again or touch this flag.
        pwned: false,
    };
    vm.runInNewContext(`fn('${htmlDecoded}')`, sandbox);
    expect(sandbox.pwned).toBe(false);
    expect(calls.length).toBe(1);
    return calls[0];
}

describe('jsEsc — onclick="fn(\'${jsEsc(x)}\')" injection safety', () => {
    const attacks = [
        `');alert(1)//`,
        `');pwned=true;fn('`,
        `\\');pwned=true//`,
        `'+pwned+'`,
        `</script><script>pwned=true</script>`,
        `" onmouseover="pwned=true`,
        `&#39;);pwned=true//`,
        `&quot;&amp;&lt;&gt;`,
        `line1\nline2`,
        `back\\slash`,
        `tab\tafter`,
        'a\u2028b\u2029c',
    ];

    for (const attack of attacks) {
        it(`neutralises: ${JSON.stringify(attack)}`, () => {
            const [arg] = roundTrip(attack);
            // The value must arrive at fn() byte-for-byte, and nothing else
            // may execute (asserted inside roundTrip).
            expect(arg).toBe(attack);
        });
    }

    it('round-trips ordinary node ids unchanged', () => {
        for (const id of ['comment', 'github_pr-1', 'A.b.c', 'idée']) {
            expect(roundTrip(id)[0]).toBe(id);
        }
    });

    it('coerces null/undefined to an empty string', () => {
        expect(jsEsc(null)).toBe('');
        expect(jsEsc(undefined)).toBe('');
        expect(roundTrip(null as unknown)[0]).toBe('');
    });

    it('still HTML-encodes the attribute-breaking characters', () => {
        // Defence in depth: even before JS parsing, " & < > must not appear
        // raw in the double-quoted attribute value.
        const out = jsEsc(`"&<>`);
        expect(out).toBe('&quot;&amp;&lt;&gt;');
    });
});
