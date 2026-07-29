# Dependency and license inventory

The production build is static browser JavaScript and CSS. The YAML parser is bundled locally into the emitted application asset; the page has no runtime CDN dependency or third-party analytics SDK.

| Dependency | Version | Use | Distributed in production build | License |
| --- | --- | --- | --- | --- |
| YAML | 2.9.0 | Non-executing YAML front-matter parsing with exact map/sequence paths | Yes, bundled locally in assets/app.js; [ISC text](public/LICENSES/YAML-ISC.txt) | ISC |
| Node.js standard library | Node 22+ | Deterministic local build and tests | No | Node.js license |
| esbuild | 0.28.1 | Local deterministic browser bundling | No | MIT |
| Playwright | 1.59.1 | Development-only real Chrome browser tests | No | Apache-2.0 |

Bundled static assets and their license texts are listed in [public/ASSET-PROVENANCE.md](public/ASSET-PROVENANCE.md).
