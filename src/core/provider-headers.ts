// Shared sanitization for custom HTTP headers on openai-compatible providers.
// Used by both config parsing (parseProvider) and the dashboard provider API
// (validateProviderBody) so every path that can produce a stored header set
// honors the exact same contract. Dependency-free on purpose, so the server
// layer can import it without pulling in the AI SDKs.

// Header names sokuza sets authoritatively on every openai-compatible request;
// a custom provider header may not shadow them (in any case).
export const RESERVED_HEADER_NAMES = new Set(['authorization', 'content-type']);

// RFC 7230 token: the characters allowed in an HTTP header field name.
export const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** True if a string contains an ASCII control char (CR/LF injection vectors). */
export function hasControlChar(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}

/**
 * Sanitize a raw `headers` map for an openai-compatible provider. Drops:
 * - non-string or empty values,
 * - reserved names (Authorization/Content-Type, any case) — set authoritatively
 *   at request time; a shadow would be combined by undici and corrupt auth,
 * - names that aren't valid HTTP tokens, or values containing control chars.
 *
 * Returns the cleaned map, or `undefined` if nothing survives (or the input
 * isn't a plain object).
 */
export function sanitizeProviderHeaders(raw: unknown): Record<string, string> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== 'string' || value.length === 0) continue;
        if (RESERVED_HEADER_NAMES.has(key.toLowerCase())) continue;
        if (!HTTP_TOKEN_RE.test(key) || hasControlChar(value)) continue;
        headers[key] = value;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
}

// Header names whose value is likely a credential, so a list/GET response
// should mask it rather than echo cleartext. Custom headers are general
// purpose (the motivating use is a non-secret User-Agent), but nothing stops
// a user storing e.g. an X-API-Key or a session cookie here.
const SECRET_HEADER_NAME_RE = /key|token|secret|auth|credential|password|cookie|session|jwt|bearer/i;

/**
 * Mask the values of secret-bearing custom headers for display (e.g. the
 * provider GET response), leaving non-sensitive ones like User-Agent readable.
 * `mask` is injected so this module stays free of the AI-SDK-loading layer
 * that owns the masking primitive.
 */
export function maskProviderHeaders(
    headers: Record<string, string> | undefined,
    mask: (value: string) => string,
): Record<string, string> | undefined {
    if (!headers) return undefined;
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
        out[name] = SECRET_HEADER_NAME_RE.test(name) ? mask(value) : value;
    }
    return out;
}
