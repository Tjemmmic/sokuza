/** String-truthy semantics shared by the runtime's `condition:` evaluator
 *  and the `flow.if` node body. Empty, "false", "0", "undefined", and
 *  "null" are falsy; everything else (including the literal "true") is
 *  truthy. Centralised so the two callers can't drift — a divergence
 *  would mean a node's `condition:` field could disagree with a
 *  flow.if downstream of it on the same expression. */
export function isStringTruthy(value: string): boolean {
    return value !== '' && value !== 'false' && value !== '0' && value !== 'undefined' && value !== 'null';
}
