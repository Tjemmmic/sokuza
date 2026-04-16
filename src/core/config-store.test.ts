import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { ConfigStore } from './config-store.js';

const TEST_DIR = join(tmpdir(), `sokuza-config-store-test-${Date.now()}`);

function makeStore(content: string): ConfigStore {
    const configPath = join(TEST_DIR, 'sokuza.config.yaml');
    const logger = pino({ level: 'silent' });
    return new ConfigStore(configPath, logger);
}

function makeStoreWithFile(content: string): ConfigStore {
    const store = makeStore(content);
    return store;
}

const BASIC_CONFIG = `
server:
  port: 3000
workflows:
  - name: test-wf
    trigger:
      source: manual
      event: push
    steps:
      - action: log
        params:
          message: hello
deck:
  - card-1
  - card-2
`;

beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
});

describe('ConfigStore', () => {
    describe('read()', () => {
        it('reads and parses YAML config from disk', async () => {
            await writeFile(makeStore(BASIC_CONFIG)['configPath'] as string, BASIC_CONFIG, 'utf-8');
            const store = makeStore(BASIC_CONFIG);
            await writeFile((store as any).configPath, BASIC_CONFIG, 'utf-8');
            const config = await store.read();
            expect(config).toHaveProperty('server');
            expect((config.server as any).port).toBe(3000);
            expect(Array.isArray(config.workflows)).toBe(true);
        });

        it('caches the result — second read does not hit disk', async () => {
            const store = makeStore(BASIC_CONFIG);
            await writeFile((store as any).configPath, BASIC_CONFIG, 'utf-8');
            const first = await store.read();
            await writeFile((store as any).configPath, 'server:\n  port: 9999\n', 'utf-8');
            const second = await store.read();
            expect((second.server as any).port).toBe(3000);
        });

        it('interpolates environment variables', async () => {
            process.env._SOKUZA_TEST_VAR = 'interpolated-value';
            const yaml = 'server:\n  port: 3000\ntoken: \${_SOKUZA_TEST_VAR}\n';
            const store = makeStore(yaml);
            await writeFile((store as any).configPath, yaml, 'utf-8');
            const config = await store.read();
            expect(config.token).toBe('interpolated-value');
            delete process.env._SOKUZA_TEST_VAR;
        });
    });

    describe('readRaw()', () => {
        it('returns raw YAML string without interpolation', async () => {
            process.env._SOKUZA_TEST_VAR2 = 'secret';
            const yaml = 'server:\n  port: 3000\ntoken: \${_SOKUZA_TEST_VAR2}\n';
            const store = makeStore(yaml);
            await writeFile((store as any).configPath, yaml, 'utf-8');
            const raw = await store.readRaw();
            expect(raw).toContain('${_SOKUZA_TEST_VAR2}');
            expect(raw).not.toContain('secret');
            delete process.env._SOKUZA_TEST_VAR2;
        });
    });

    describe('write()', () => {
        it('writes structured data as YAML atomically', async () => {
            const store = makeStore('');
            const data = { server: { port: 3001 }, deck: ['a', 'b'] };
            await store.write(data);
            const config = await store.read();
            expect((config.server as any).port).toBe(3001);
            expect(config.deck).toEqual(['a', 'b']);
        });

        it('invalidates cache after write', async () => {
            const store = makeStore(BASIC_CONFIG);
            await writeFile((store as any).configPath, BASIC_CONFIG, 'utf-8');
            await store.read();
            await store.write({ server: { port: 9999 } });
            const config = await store.read();
            expect((config.server as any).port).toBe(9999);
        });
    });

    describe('writeRaw()', () => {
        it('writes raw YAML string to disk', async () => {
            const store = makeStore('');
            await store.writeRaw('server:\n  port: 4000\n');
            const config = await store.read();
            expect((config.server as any).port).toBe(4000);
        });

        it('rejects invalid YAML', async () => {
            const store = makeStore('');
            await expect(store.writeRaw('server: [broken: yaml')).rejects.toThrow();
        });

        it('invalidates cache after writeRaw', async () => {
            const store = makeStore(BASIC_CONFIG);
            await writeFile((store as any).configPath, BASIC_CONFIG, 'utf-8');
            await store.read();
            await store.writeRaw('server:\n  port: 5555\n');
            const config = await store.read();
            expect((config.server as any).port).toBe(5555);
        });

        it('preserves env var placeholders on disk', async () => {
            process.env._SOKUZA_TEST_VAR3 = 'my-token';
            const store = makeStore('');
            await store.writeRaw('server:\n  port: 3000\ntoken: \${_SOKUZA_TEST_VAR3}\n');
            const raw = await store.readRaw();
            expect(raw).toContain('${_SOKUZA_TEST_VAR3}');
            delete process.env._SOKUZA_TEST_VAR3;
        });
    });

    describe('invalidateCache()', () => {
        it('forces next read to hit disk', async () => {
            const store = makeStore(BASIC_CONFIG);
            await writeFile((store as any).configPath, BASIC_CONFIG, 'utf-8');
            await store.read();
            await writeFile((store as any).configPath, 'server:\n  port: 7777\n', 'utf-8');
            store.invalidateCache();
            const config = await store.read();
            expect((config.server as any).port).toBe(7777);
        });
    });

    describe('update()', () => {
        it('reads interpolated, mutates, and writes back', async () => {
            const store = makeStore(BASIC_CONFIG);
            await writeFile((store as any).configPath, BASIC_CONFIG, 'utf-8');
            const result = await store.update((config) => {
                const deck = (config.deck as string[]) ?? [];
                deck.push('card-3');
                config.deck = deck;
                return deck;
            });
            expect(result).toContain('card-3');
            const fresh = await store.read();
            expect((fresh.deck as string[]).length).toBe(3);
        });
    });

    describe('updateRaw()', () => {
        it('reads raw without interpolation, mutates, writes back', async () => {
            process.env._SOKUZA_TEST_VAR4 = 'secret-value';
            const yaml = 'server:\n  port: 3000\ntoken: \${_SOKUZA_TEST_VAR4}\ndeck:\n  - a\n';
            const store = makeStore(yaml);
            await writeFile((store as any).configPath, yaml, 'utf-8');

            await store.updateRaw((config) => {
                const deck = (config.deck as string[]) ?? [];
                deck.push('b');
                config.deck = deck;
                return undefined;
            });

            const raw = await store.readRaw();
            expect(raw).toContain('${_SOKUZA_TEST_VAR4}');
            const parsed = await store.read();
            expect((parsed.deck as string[])).toEqual(['a', 'b']);
            delete process.env._SOKUZA_TEST_VAR4;
        });

        it('returns the mutator result', async () => {
            const store = makeStore(BASIC_CONFIG);
            await writeFile((store as any).configPath, BASIC_CONFIG, 'utf-8');
            const count = await store.updateRaw((config) => {
                return ((config.deck as string[]) ?? []).length;
            });
            expect(count).toBe(2);
        });
    });

    describe('atomic writes', () => {
        it('uses tmp file + rename — no residual .tmp file on success', async () => {
            const store = makeStore('');
            await store.writeRaw('server:\n  port: 3000\n');
            const { readdir } = await import('node:fs/promises');
            const files = await readdir(TEST_DIR);
            expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
        });
    });
});
