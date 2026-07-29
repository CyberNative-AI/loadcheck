# Dependency and license inventory

The production build is plain browser JavaScript and CSS. It has no runtime package dependency, CDN dependency, or third-party analytics SDK.

| Dependency | Version | Use | Distributed in production build | License |
| --- | --- | --- | --- | --- |
| Node.js standard library | Node 22+ | deterministic local build and tests | No | Node.js license |
| Playwright | 1.59.1 | development-only real Chrome browser tests | No | Apache-2.0 |

Bundled static assets and their license texts are listed in [public/ASSET-PROVENANCE.md](public/ASSET-PROVENANCE.md).
