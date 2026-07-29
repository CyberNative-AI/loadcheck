# Loadcheck

Does loading this Hugging Face repo run code? Loadcheck is a static, browser-only checker for a small set of observable loading-risk signals in public Hugging Face model and dataset repositories.

## Run locally

Requires Node 22 or newer.

```sh
npm run build
npm test
```

Serve `dist/` with any static file server. The browser contacts only the same origin and `https://huggingface.co`.

## Method

Loadcheck resolves the submitted public repository to a commit SHA before reading its tree. It reads only `config.json` for models and `README.md` front matter for datasets, with a 1 MiB limit per file. It does not download weights, execute repository code, render templates, or use a Hub token.

It reports a custom `auto_map` mapping, a dataset root loading script, Jinja syntax under dataset `configs`, pickle-capable model paths when no `.safetensors` path exists, and unpinned revisions. API, parsing, size, pagination, rate-limit, and browser network failures fail closed as incomplete checks.

## Privacy

The submitted repository ID goes from the browser to Hugging Face. Loadcheck sends one fixed-path, same-origin completion request after a terminal result; it has no body, query string, repository ID, type, revision, result, or timestamp. There are no cookies, local storage, service worker, analytics, or backend.

## Sources

- [Transformers loading models](https://huggingface.co/docs/transformers/main_classes/model)
- [Datasets loading scripts](https://huggingface.co/docs/datasets/dataset_script)
- [Hub pickle scanning](https://huggingface.co/docs/hub/security-pickle)
- [Dataset manual configuration](https://huggingface.co/docs/hub/datasets-manual-configuration)

## License

MIT. See [LICENSE](LICENSE).
