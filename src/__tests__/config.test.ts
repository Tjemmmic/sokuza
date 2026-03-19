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

    it('should throw when server section is missing', async () => {
        const configPath = join(TMP_DIR, 'no-server.yaml');
        await writeFile(configPath, 'workflows: []');

        await expect(loadConfig(configPath)).rejects.toThrow(
            'Config must include a "server" section',
        );
    });
});
