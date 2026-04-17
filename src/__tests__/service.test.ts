import { describe, it, expect } from 'vitest';
import {
    captureServicePath,
    renderLinuxUnit,
    renderMacOSPlist,
    type InstallCtx,
} from '../cli/service.js';

function escapeForRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ctx: InstallCtx = {
    configPath: '/home/alice/sokuza/sokuza.config.yaml',
    nodeBin: '/home/alice/.nvm/versions/node/v22.5.0/bin/node',
    entry: '/home/alice/.nvm/versions/node/v22.5.0/lib/node_modules/sokuza/dist/index.js',
    workdir: '/home/alice/sokuza',
    servicePath: '/home/alice/.local/bin:/home/alice/.nvm/versions/node/v22.5.0/bin:/usr/local/bin:/usr/bin:/bin',
};

describe('captureServicePath', () => {
    it('appends required Unix dirs when the user PATH omits them', () => {
        const out = captureServicePath({ PATH: '/home/alice/.local/bin' });
        if (process.platform === 'win32') {
            expect(out).toBe('/home/alice/.local/bin');
        } else {
            expect(out.split(':')).toEqual([
                '/home/alice/.local/bin',
                '/usr/local/bin',
                '/opt/homebrew/bin',
                '/usr/bin',
                '/bin',
                '/usr/sbin',
                '/sbin',
            ]);
        }
    });

    it('does not duplicate required dirs already in PATH', () => {
        const out = captureServicePath({
            PATH: '/home/alice/.local/bin:/usr/local/bin:/usr/bin:/bin',
        });
        if (process.platform === 'win32') return;
        const parts = out.split(':');
        expect(parts.filter((p) => p === '/usr/bin')).toHaveLength(1);
        expect(parts.filter((p) => p === '/usr/local/bin')).toHaveLength(1);
    });

    it('returns an empty-ish PATH when none is set rather than throwing', () => {
        const out = captureServicePath({});
        if (process.platform === 'win32') {
            expect(out).toBe('');
        } else {
            // Still produces the required dirs so the service has something usable.
            expect(out).toContain('/usr/bin');
        }
    });
});

describe('renderLinuxUnit', () => {
    const unit = renderLinuxUnit(ctx);

    it('bakes the captured PATH into Environment= so systemd does not strip NVM shims', () => {
        expect(unit).toContain(`Environment="PATH=${ctx.servicePath}"`);
        // The old behaviour was PassEnvironment=PATH, which inherits from the
        // manager env and therefore loses user-shell additions. Make sure we
        // are not regressing to that.
        expect(unit).not.toMatch(/^PassEnvironment=PATH\b/m);
    });

    it('invokes the baked node binary and entry script with --config', () => {
        // shellQuote only wraps paths that contain shell-unsafe chars — our
        // test paths don't, so they appear unquoted. Check the full line
        // instead of asserting specific quoting.
        expect(unit).toMatch(
            new RegExp(
                `^ExecStart=\\S*${escapeForRegex(ctx.nodeBin)}\\S*\\s+\\S*${escapeForRegex(ctx.entry)}\\S*\\s+start\\s+--config\\s+\\S*${escapeForRegex(ctx.configPath)}\\S*\\s*$`,
                'm',
            ),
        );
    });

    it('shell-quotes paths with spaces', () => {
        const spaced = renderLinuxUnit({
            ...ctx,
            configPath: '/home/alice/my sokuza/config.yaml',
        });
        expect(spaced).toContain('--config "/home/alice/my sokuza/config.yaml"');
    });

    it('restart-on-failure is configured so crashes auto-recover', () => {
        expect(unit).toContain('Restart=on-failure');
        expect(unit).toContain('RestartSec=5');
    });

    it('targets default.target so it starts at user login', () => {
        expect(unit).toContain('WantedBy=default.target');
    });
});

describe('renderMacOSPlist', () => {
    const plist = renderMacOSPlist(ctx, '/home/alice/.sokuza/logs');

    it('bakes the captured PATH into EnvironmentVariables', () => {
        expect(plist).toContain('<key>PATH</key>');
        expect(plist).toContain(`<string>${ctx.servicePath}</string>`);
    });

    it('uses the captured node binary and entry script', () => {
        expect(plist).toContain(`<string>${ctx.nodeBin}</string>`);
        expect(plist).toContain(`<string>${ctx.entry}</string>`);
    });

    it('enables RunAtLoad and KeepAlive so launchd relaunches after crashes', () => {
        expect(plist).toContain('<key>RunAtLoad</key><true/>');
        expect(plist).toContain('<key>KeepAlive</key><true/>');
    });

    it('routes stdout and stderr to the sokuza log dir', () => {
        expect(plist).toContain('<string>/home/alice/.sokuza/logs/stdout.log</string>');
        expect(plist).toContain('<string>/home/alice/.sokuza/logs/stderr.log</string>');
    });

    it('escapes XML-special characters in baked paths', () => {
        const tricky: InstallCtx = {
            ...ctx,
            configPath: '/tmp/evil & <path>.yaml',
            servicePath: '/usr/local/bin:/weird & <path>',
        };
        const out = renderMacOSPlist(tricky, '/tmp/logs');
        expect(out).toContain('/tmp/evil &amp; &lt;path&gt;.yaml');
        expect(out).toContain('/weird &amp; &lt;path&gt;');
        expect(out).not.toContain('/tmp/evil & <path>.yaml');
    });
});
