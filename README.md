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

It reports custom `auto_map` mappings that current Transformers loads execute only after an explicit `trust_remote_code=True` opt-in; legacy Datasets v3.4 root loading scripts, whose repository code ran only after the same explicit opt-in; and pickle-capable model paths when no `.safetensors` path exists. Template-like delimiters below dataset README `configs` are neutral manual-review signals, not evidence of code execution or a pinning requirement: current YAML builder parameters work without custom code, and no current standard Hugging Face loading call is documented to render those delimiters. API, parsing, size, pagination, rate-limit, and browser network failures fail closed as incomplete checks.

## Privacy

The submitted repository ID goes from the browser to Hugging Face. Loadcheck sends one fixed-path, same-origin completion request after a terminal result; it has no body, query string, repository ID, type, revision, result, or timestamp. There are no cookies, local storage, service worker, analytics, or backend.

## Sources

- [Transformers supported models](https://huggingface.co/docs/transformers/models)
- [Transformers Auto classes and `trust_remote_code`](https://huggingface.co/docs/transformers/model_doc/auto)
- [Legacy Datasets v3.4 loading scripts](https://huggingface.co/docs/datasets/v3.4.0/en/dataset_script)
- [Hub pickle scanning](https://huggingface.co/docs/hub/security-pickle)
- [Dataset manual configuration](https://huggingface.co/docs/hub/en/datasets-manual-configuration)

## License

MIT. See [LICENSE](LICENSE).

## Need this done on your own documents?

We run a fixed-price extraction service: up to 250 documents, up to 20 fields,
$245, five business days from the day we agree the field list. Each value in the
CSV either carries the file and page number it was read from, or is marked as one
we could not tie to a page — so you can check the output against the source
yourself.

Full scope, what arrives, and the numbers from our own runs:
https://cybernative.ai/services/documents-to-csv/

Questions: hello@cybernative.ai
