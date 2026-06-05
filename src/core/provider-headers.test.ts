import { describe, it, expect } from 'vitest';
import { sanitizeProviderHeaders, maskProviderHeaders } from './provider-headers.js';

describe('sanitizeProviderHeaders', () => {
    it('keeps valid custom headers', () => {
        expect(sanitizeProviderHeaders({ 'User-Agent': 'claude-code/0.1.0', 'X-Foo': 'bar' }))
            .toEqual({ 'User-Agent': 'claude-code/0.1.0', 'X-Foo': 'bar' });
    });

    it('drops reserved names (Authorization/Content-Type) in any case', () => {
        expect(sanitizeProviderHeaders({
            authorization: 'Bearer evil',
            Authorization: 'Bearer evil',
            'content-type': 'text/plain',
            'CONTENT-TYPE': 'text/plain',
            'User-Agent': 'ok',
        })).toEqual({ 'User-Agent': 'ok' });
    });

    it('drops non-string, empty, invalid-name, and control-char values', () => {
        expect(sanitizeProviderHeaders({
            'X-Num': 5,                 // non-string
            'X-Empty': '',              // empty
            'Bad Name': 'x',            // space → invalid HTTP token
            'X-Inject': 'a\r\nB: c',    // CRLF
            'X-Null': 'a\u0000b',       // NUL
            'X-Good': 'fine',
        })).toEqual({ 'X-Good': 'fine' });
    });

    it('returns undefined for non-objects, arrays, and empty results', () => {
        expect(sanitizeProviderHeaders(undefined)).toBeUndefined();
        expect(sanitizeProviderHeaders(null)).toBeUndefined();
        expect(sanitizeProviderHeaders('x')).toBeUndefined();
        expect(sanitizeProviderHeaders(['a', 'b'])).toBeUndefined();
        expect(sanitizeProviderHeaders({})).toBeUndefined();
        expect(sanitizeProviderHeaders({ Authorization: 'x' })).toBeUndefined();
    });
});

describe('maskProviderHeaders', () => {
    const mask = () => 'MASKED';

    it('masks values for secret-bearing header names, leaves others readable', () => {
        expect(maskProviderHeaders({
            'User-Agent': 'claude-code/0.1.0',
            'X-API-Key': 'super-secret',
            'X-Auth-Token': 'tok_123',
            'X-Tenant-Secret': 'shh',
            'X-Password': 'hunter2',
            'Cookie': 'session=abc',
            'X-Session-Id': 'sess_1',
            'X-JWT': 'eyJ...',
            'X-Request-Id': 'req-42',
        }, mask)).toEqual({
            'User-Agent': 'claude-code/0.1.0',
            'X-API-Key': 'MASKED',
            'X-Auth-Token': 'MASKED',
            'X-Tenant-Secret': 'MASKED',
            'X-Password': 'MASKED',
            'Cookie': 'MASKED',
            'X-Session-Id': 'MASKED',
            'X-JWT': 'MASKED',
            'X-Request-Id': 'req-42',
        });
    });

    it('returns undefined when there are no headers', () => {
        expect(maskProviderHeaders(undefined, mask)).toBeUndefined();
    });
});
