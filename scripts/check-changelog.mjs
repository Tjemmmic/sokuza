#!/usr/bin/env node
/**
 * Validate that CHANGELOG.md has an entry for the current package.json version.
 *
 * Run by:
 *   - `prepublishOnly` so a local `npm publish` can't go out without notes
 *   - the release CI workflow as a hard gate before `npm publish`
 *
 * The check is intentionally simple: read package.json's version, then
 * search CHANGELOG.md for a line matching `## [<version>]` (with optional
 * trailing date in `YYYY-MM-DD` form). Anything fancier (date format,
 * "Unreleased" hygiene, contiguous version order) is left to humans.
 *
 * Exit 0 when valid, 1 when missing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(here));

const pkgPath = join(repoRoot, 'package.json');
const changelogPath = join(repoRoot, 'CHANGELOG.md');

let version;
try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    version = pkg.version;
    if (typeof version !== 'string' || version.length === 0) {
        throw new Error('package.json has no version string');
    }
} catch (err) {
    process.stderr.write(`check-changelog: failed to read package.json — ${err.message}\n`);
    process.exit(1);
}

let changelog;
try {
    changelog = readFileSync(changelogPath, 'utf-8');
} catch (err) {
    process.stderr.write(`check-changelog: CHANGELOG.md not found — ${err.message}\n`);
    process.exit(1);
}

// Match `## [X.Y.Z]` at start of a line, allowing pre-release / build
// metadata segments and an optional trailing ` - YYYY-MM-DD`. Anchored to
// avoid partial matches inside prose.
const escaped = version.replace(/[.+]/g, '\\$&');
const headingRe = new RegExp(`^##\\s+\\[${escaped}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, 'm');

if (!headingRe.test(changelog)) {
    process.stderr.write(
        `check-changelog: no entry for version "${version}" in CHANGELOG.md\n` +
        `  Add a heading: ## [${version}] - ${new Date().toISOString().slice(0, 10)}\n` +
        `  Then describe what changed under it.\n`,
    );
    process.exit(1);
}

process.stdout.write(`check-changelog: ✓ CHANGELOG.md has an entry for ${version}\n`);
