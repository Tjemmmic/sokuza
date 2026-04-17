import { describe, it, expect, beforeEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../core/config.js';

const TMP_DIR = join(import.meta.dirname ?? '.', '../../.tmp-test');

describe('loadConfig', () => {
    beforeEach(async () => {
        await mkdir(TMP_DIR, { recursive: true });
    });

    it('should load a valid YAML config', async () => {
        const configContent = `
server:
  port: 4000
integrations:
  github:
    webhookSecret: "test-secret"
workflows:
  - name: test-wf
    trigger:
      source: github
      event: issues.opened
    steps:
      - action: log
        params:
          message: hello
`;
        const configPath = join(TMP_DIR, 'valid.yaml');
        await writeFile(configPath, configContent);

        const config = await loadConfig(configPath);

        expect(config.server.port).toBe(4000);
        expect(config.integrations.github).toBeDefined();
        expect(config.workflows).toHaveLength(1);
        expect(config.workflows[0].name).toBe('test-wf');
    });

    it('should interpolate environment variables', async () => {
        process.env.TEST_SECRET = 'my-secret-value';

        const configContent = `
server:
  port: 3500
integrations:
  github:
    webhookSecret: "\${TEST_SECRET}"
workflows: []
`;
        const configPath = join(TMP_DIR, 'env.yaml');
        await writeFile(configPath, configContent);

        const config = await loadConfig(configPath);
        expect(config.integrations.github.webhookSecret).toBe('my-secret-value');

        delete process.env.TEST_SECRET;
    });

    it('should throw on missing config file', async () => {
        await expect(loadConfig('/nonexistent/path.yaml')).rejects.toThrow(
            'Failed to read config file',
        );
    });

    it('should default to the canonical discovery port when server section is missing', async () => {
        const configPath = join(TMP_DIR, 'no-server.yaml');
        await writeFile(configPath, 'workflows: []');

        const config = await loadConfig(configPath);
        expect(config.server.port).toBe(24847);
        expect(config.server.host).toBe('0.0.0.0');
    });

    it('should reject non-numeric server.port', async () => {
        const configPath = join(TMP_DIR, 'bad-port.yaml');
        await writeFile(configPath, 'server:\n  port: "oops"\nworkflows: []\n');

        await expect(loadConfig(configPath)).rejects.toThrow(
            'server.port must be a number',
        );
    });

    it('should validate workflow-level queue overrides at startup', async () => {
        const configContent = `
server:
  port: 4000
workflows:
  - name: bad-queue-wf
    trigger:
      source: manual
      event: push
    steps:
      - action: log
        params:
          message: hello
    queue:
      concurrency: -5
`;
        const configPath = join(TMP_DIR, 'bad-wf-queue.yaml');
        await writeFile(configPath, configContent);

        await expect(loadConfig(configPath)).rejects.toThrow(
            /workflows\[0].*queue.*concurrency.*positive/,
        );
    });

    it('should accept valid workflow-level queue overrides', async () => {
        const configContent = `
server:
  port: 4000
workflows:
  - name: good-queue-wf
    trigger:
      source: manual
      event: push
    steps:
      - action: log
        params:
          message: hello
    queue:
      concurrency: 5
      timeout: 60
      dedup: latest-wins
`;
        const configPath = join(TMP_DIR, 'good-wf-queue.yaml');
        await writeFile(configPath, configContent);

        const config = await loadConfig(configPath);
        expect(config.workflows[0].queue?.concurrency).toBe(5);
    });
});
