# Vendored dashboard assets

Third-party browser assets served locally (no runtime CDN) so the Terminal
page works offline / in firewalled environments. Copied verbatim from the
pinned npm packages — the files are byte-identical to upstream; verify with
`sha256sum` against the hashes below before updating.

| File | Source package | Version | SHA-256 |
| --- | --- | --- | --- |
| `xterm.js` | `@xterm/xterm` (`lib/xterm.js`) | 5.5.0 | `1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495` |
| `xterm.css` | `@xterm/xterm` (`css/xterm.css`) | 5.5.0 | `ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6` |
| `addon-fit.js` | `@xterm/addon-fit` (`lib/addon-fit.js`) | 0.10.0 | `bdaefa370b1bfc42ee88d46fe6072400902a4d4b2d45cd93438dda9b23c97089` |

## Updating

```sh
npm install --save-dev @xterm/xterm@<v> @xterm/addon-fit@<v>
cp node_modules/@xterm/xterm/lib/xterm.js       dashboard/vendor/xterm.js
cp node_modules/@xterm/xterm/css/xterm.css      dashboard/vendor/xterm.css
cp node_modules/@xterm/addon-fit/lib/addon-fit.js dashboard/vendor/addon-fit.js
sha256sum dashboard/vendor/*   # update the table above
```
