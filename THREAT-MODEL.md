# Threat model

Repository IDs, Hub metadata, tree paths, JSON values, and README text are untrusted. The interface validates input before URL construction, binds reads to the resolved commit SHA, and inserts all repository-controlled values with DOM text APIs.

The only permitted browser destinations are the page origin and `https://huggingface.co`. The app does not use credentials, storage, service workers, dynamic imports, HTML insertion, template evaluation, `eval`, or `new Function`.

The app fetches only public repository metadata, the tree, and bounded `config.json` or `README.md` text. It does not fetch blobs, arbitrary data files, model weights, local files, pull-request refs, private repositories, or Spaces. Input, API, parsing, pagination, size, and browser failures return an incomplete result.
