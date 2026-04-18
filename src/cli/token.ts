import { loadOrCreateDashboardToken, rotateDashboardToken, tokenFilePath } from '../server/auth.js';
import { listRuntimeStates } from '../server/discovery.js';

export interface TokenOptions {
    /** Generate a new token, invalidating the old one. */
    rotate?: boolean;
    /** Emit JSON instead of human-readable output. */
    json?: boolean;
}

/**
 * Print — or rotate — the dashboard bearer token. Also prints a ready-to-paste
 * URL for any currently-running instance so users can tap straight into the
 * authenticated dashboard without copy-pasting two pieces.
 *
 * `--rotate` invalidates the old token. A running engine re-reads the token
 * file when `/api/*` requests come in? No — the engine caches it at startup
 * today, so rotation requires a restart. We surface that clearly instead of
 * pretending otherwise.
 */
export async function runToken(opts: TokenOptions): Promise<void> {
    const token = opts.rotate
        ? await rotateDashboardToken()
        : await loadOrCreateDashboardToken();

    const states = await listRuntimeStates();
    const urls = states.map((s) => `http://localhost:${s.port}/?t=${token}`);

    if (opts.json) {
        process.stdout.write(JSON.stringify(
            { token, tokenFile: tokenFilePath(), urls, rotated: !!opts.rotate },
            null, 2,
        ) + '\n');
        return;
    }

    if (opts.rotate) {
        process.stdout.write(`Rotated dashboard token.\n`);
        process.stdout.write(`Existing dashboard tabs will be signed out on their next /api call.\n`);
        if (states.length > 0) {
            process.stdout.write(`Restart sokuza so running instances pick up the new token.\n`);
        }
        process.stdout.write('\n');
    }

    process.stdout.write(`Token: ${token}\n`);
    process.stdout.write(`Stored at: ${tokenFilePath()} (mode 0600)\n`);

    if (urls.length === 0) {
        process.stdout.write(
            `\nNo running sokuza found. Start one with \`sokuza\`, then load the link ` +
            `from its startup log (or re-run \`sokuza token\` once it's up).\n`,
        );
        return;
    }

    process.stdout.write(`\nPaste one of these into a browser to open the dashboard:\n`);
    for (const url of urls) {
        process.stdout.write(`  ${url}\n`);
    }
}
