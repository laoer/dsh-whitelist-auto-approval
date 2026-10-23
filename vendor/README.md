# Vendored schema libraries

This directory vendors the two MIT-licensed packages the plugin needs to declare
a Host `Config` schema without depending on the profile's `node_modules`:

| Directory | Upstream package | Version | Source |
|---|---|---|---|
| `schemastery/` | `@deepseek-ai/schemastery` | 3.18.5 | `lib/index.mjs` of the package installed with DSH 0.2.1-rc.2 |
| `cosmokit/` | `@deepseek-ai/cosmokit` | 1.8.6 | `lib/index.js` of the same installation |

Why vendor instead of declaring a dependency: this bundle is installed from a
local directory as a `link:`, so Node resolves imports from the checkout's real
path. The profile's `node_modules` is not on that path, and a linked package's
dependencies are not installed into the checkout. Vendoring keeps the bundle
working with no `pnpm install` step.

The only change to upstream code is the first import in
`schemastery/index.mjs`:

```diff
- from "@deepseek-ai/cosmokit"
+ from "../cosmokit/index.js"
```

Everything else is byte-for-byte upstream (SHA-256 of the copies before the
import change matched the installed packages). Both licenses are retained next
to the code.

Upgrade both copies together when DSH upgrades its schemastery version. The
contract this plugin relies on is small and explicit:

- `schema["~standard"]` with `vendor: "schemastery"` (Cordis config validation)
- `schema.toJSON()` and reconstructing it with `new Schema(json)` (settings form)
- `schema.meta.volatile` / `schema.dict` / `schema.inner` (loader + settings)
- `.volatile()` on the `rules` field (live config updates without a remount)
