# pi-openrouter-floor

A [pi coding agent](https://github.com/earendil-works/pi) extension that registers a **`:floor` twin of every agentic-usable OpenRouter model**, so you can always pick the cheapest provider for a given model.

`:floor` is an OpenRouter request-time routing variant: it sorts the model's providers by price (and admits discounted flex-tier endpoints). It is not listed in OpenRouter's `/models` catalog, so this extension clones the catalog at startup — the floor list is rebuilt on every pi start and stays in sync with OpenRouter automatically.

## Features

- **Live catalog sync.** Fetches `https://openrouter.ai/api/v1/models` at pi startup; every agentic-usable model (tools + reasoning, plus `~` and `openrouter/*` aliases) gets a `openrouter-floor/<id>:floor` twin with the base model's metadata (context window, pricing, reasoning, image input). Ids that already carry a variant suffix (e.g. `:free`, `:batch`) are skipped.
- **`/floor` toggle.** Switches between the active OpenRouter model and its floor twin (and back), like `/thinking`. Recorded in session history, restored on resume.
- **Zero cost overhead.** No extra requests beyond one catalog fetch per pi start; no runtime dependencies.
- If OpenRouter is unreachable at startup, registration is silently skipped and everything else works as before.

## Install

```bash
pi install git:github.com/herijooj/pi-openrouter-floor
```

Then `/reload` or restart pi. Models appear as `openrouter-floor/<id>:floor` in `/model`, or run:

```
pi --list-models | grep floor
```

## Authentication

Uses your existing OpenRouter credentials — the same ones pi uses:

- `OPENROUTER_API_KEY` environment variable, or
- the `openrouter` entry in `~/.pi/agent/auth.json` (from `/login openrouter`; an `sk-or-` key in `.key`/string form or the OAuth `access` token).

## Caveats

- Session cost estimates for floor twins use the base model's list price; the provider actually serving you may bill less — estimates are conservative, not exact.
- Agentic-usable filter mirrors pi-openrouter-advanced-provider's: `tools` parameter required and evidence of reasoning support, unless the id starts with `~` or `openrouter/`.
- `:floor` changes *provider routing*, not the model — output quality can differ between providers for the same model.

## License

MIT
