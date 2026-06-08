import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// updatePanelHtml lives in app.js (a bundler-less browser file full of DOM
// globals we can't evaluate wholesale). Extract just that function plus its
// lone dependency `esc` and run them in a vm — exercising exactly the bytes
// the dashboard ships, the same approach as dashboard-jsesc.test.ts.
function loadUpdatePanelHtml(): (upd: unknown, serviceInstalled: boolean) => string {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '../../dashboard/app.js'), 'utf8');
    const escM = src.match(/function esc\(s\) \{[\s\S]*?\n\}/);
    const fnM = src.match(/function updatePanelHtml\(upd, serviceInstalled\) \{[\s\S]*?\n\}/);
    if (!escM || !fnM) throw new Error('updatePanelHtml/esc not found in app.js');
    const sandbox: { updatePanelHtml?: (u: unknown, s: boolean) => string } = {};
    vm.runInNewContext(`${escM[0]}; ${fnM[0]}; this.updatePanelHtml = updatePanelHtml;`, sandbox);
    return sandbox.updatePanelHtml!;
}

const updatePanelHtml = loadUpdatePanelHtml();

// The button handlers identify each action uniquely in the rendered HTML.
const UPDATE_NOW = 'systemRunUpdate()';
const RESTART_BUTTON = 'systemServiceRestart(this)';
const CHECK = 'systemCheckUpdate()';

describe('updatePanelHtml', () => {
    it('error snapshot renders the message and no action buttons', () => {
        const html = updatePanelHtml({ error: 'npm registry unreachable' }, true);
        expect(html).toContain('npm registry unreachable');
        expect(html).not.toContain(UPDATE_NOW);
        expect(html).not.toContain(RESTART_BUTTON);
    });

    it('up to date: neither Update now nor Restart appears', () => {
        const html = updatePanelHtml(
            { current: '0.2.6', installed: '0.2.6', latest: '0.2.6', updateAvailable: false, restartRequired: false, checkedAt: 1 }, true);
        expect(html).toContain('up to date');
        expect(html).not.toContain(UPDATE_NOW);
        expect(html).not.toContain(RESTART_BUTTON);
    });

    it('updateAvailable: shows Update now, not Restart', () => {
        const html = updatePanelHtml(
            { current: '0.2.6', installed: '0.2.6', latest: '0.3.0', updateAvailable: true, restartRequired: false, checkedAt: 1 }, true);
        expect(html).toContain(UPDATE_NOW);
        expect(html).toContain('update available');
        expect(html).not.toContain(RESTART_BUTTON);
    });

    it('restartRequired with a service: shows the Restart to apply button, not Update now', () => {
        const html = updatePanelHtml(
            { current: '0.2.6', installed: '0.3.0', latest: '0.3.0', updateAvailable: false, restartRequired: true, checkedAt: 1 }, true);
        expect(html).toContain(RESTART_BUTTON);
        expect(html).toContain('restart to apply');
        expect(html).toContain('0.3.0'); // the installed version is surfaced
        expect(html).not.toContain(UPDATE_NOW);
    });

    it('restartRequired without a service: shows a restart hint, not the button', () => {
        const html = updatePanelHtml(
            { current: '0.2.6', installed: '0.3.0', latest: '0.3.0', updateAvailable: false, restartRequired: true, checkedAt: 1 }, false);
        expect(html).not.toContain(RESTART_BUTTON);
        expect(html).toContain('Restart sokuza to apply');
    });

    it('both states: installed ahead of running AND a newer release → both buttons', () => {
        const html = updatePanelHtml(
            { current: '0.2.6', installed: '0.3.0', latest: '0.4.0', updateAvailable: true, restartRequired: true, checkedAt: 1 }, true);
        expect(html).toContain(UPDATE_NOW);
        expect(html).toContain(RESTART_BUTTON);
    });

    it('always offers a Check for updates button, even with no prior check', () => {
        const html = updatePanelHtml(
            { current: '0.2.6', installed: '0.2.6', latest: null, updateAvailable: false, restartRequired: false, checkedAt: null }, true);
        expect(html).toContain(CHECK);
        expect(html).toContain('no check yet');
    });
});
