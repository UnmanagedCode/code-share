> See also: [README](../README.md) (features, routes, the test map) · code-conductor's `docs/plugin-ui.md` (the host contract and reference setup this follows)

# Frontend

code-share has two pages, built from `frontend/` into `frontend/dist/`:

| Page | Entry | Served by | Audience |
|---|---|---|---|
| Web UI | `frontend/index.html` → `src/main.tsx` → `App` | the web UI server (`src/webui.js`), loopback only; inside code-conductor through its `/plugins/code-share/` proxy | the local user |
| Connect page | `frontend/connect.html` → `src/connect.tsx` → `ConnectPage` | the git server (`src/server.js`) at `/connect`, unauthenticated, tunneled | whoever scans the QR code |

## Stack

React, Vite 8, Tailwind v4, code-conductor's shadcn/Radix components (copied, one file each), lucide icons, Geist fonts (from the host only). Everything the UI uses is a devDependency, bundled at build time.

```
frontend/
  index.html  connect.html          the two Vite entries
  vite.config.mts  vitest.config.mts  tsconfig.json
  public/theme-init.js              standalone theme (copied to dist as is)
  src/
    main.tsx  App.tsx               web UI
    connect.tsx  ConnectPage.tsx    connect page
    index.css  cc-theme-fallback.css
    components/                     the sections and shared pieces
      ui/                           copied from code-conductor's web/src/components/ui
    lib/                            api, connection strings, polling, peer rows, clipboard
    test/                           vitest setup, fetch stub, the shared cs1 vector
```

- The package is CommonJS (the backend uses `require`), so the Vite and Vitest configs are `.mts` and no `type` is set in `package.json`.
- `cacheDir` sits in `frontend/.vite-cache`, so dev and test runs never write through a symlinked `node_modules`.

## Build on install

- `npm install` runs `prepare` (`vite build --config frontend/vite.config.mts`), which writes `frontend/dist/`. code-conductor's Library entry runs `npm install` after clone and after pull.
- `frontend/dist/`, `frontend/.vite-cache/` and `package-lock.json` are ignored, so a build never dirties the checkout.
- With no build, both servers still start. `startWebUI` logs `UI not built: <path> is missing — run npm install`, and `/` and `/connect` answer a `text/plain` 503 that says the same. The API keeps working.

## One build, two servers

- One multi-page Vite build (`build.rolldownOptions.input`) emits both pages, shared chunks and one CSS file under `assets/`, plus `.vite/manifest.json` (`build.manifest`).
- `src/static.js` owns what each server may serve:
  - `serveUi`: `/` and `/index.html` → `index.html`; `/theme-init.js` and `/assets/<name>.(js|css)` (the `UI_ASSET_RE` allowlist). Anything else is a 404, with no SPA fallback, so the host URLs 404 standalone.
  - `serveConnect`: `/connect` → `connect.html`, `/theme-init.js`, and only the `assets/` files in `connectAssets(manifest)`, the import closure of the `connect.html` entry. The manifest is read per request, so a rebuild needs no restart. Any other `/assets/*` is a plain 404, never an auth challenge.
- `.map` files and `.vite/` are never served.

## The connect page loads no host URL

- It is served by the git server on the public origin, never under code-conductor's `/plugins/<id>/`, so there is no host theme to follow.
- On that origin `/pluginBridge.js` and `/pluginTheme.css` would hit token auth. The 401 carries `WWW-Authenticate`, which can make a remote visitor's browser ask for a password.
- So it loads only `theme-init.js` and its own bundle. It shows the snapshot palette, follows the OS light/dark setting live, and uses the system font.
- It reads `location.hash` once (the token rides the fragment so it never reaches a server) and never writes it. It never connects anything by itself.

## Theme

| File | Role |
|---|---|
| `src/index.css` | Tailwind, `tw-animate-css`, the fallback, `@custom-variant dark`, and the `@theme inline` token map (code-conductor's reference block, kept verbatim) |
| `src/cc-theme-fallback.css` | A one-time snapshot of code-conductor's `web/src/themeTokens.css` wrapped in `@layer base`. Embedded, the host's unlayered `/pluginTheme.css` wins; standalone, this is the palette. Never update it to track code-conductor |
| `public/theme-init.js` | Standalone only: toggles `.dark` from `prefers-color-scheme`, live. Embedded, the bridge has set `data-cc-theme` and owns `.dark`, so it does nothing |

- `index.html` loads, in order: `/pluginBridge.js` (blocking), `/pluginTheme.css`, `theme-init.js`, the module.
- No theme toggle of the page's own: inside code-conductor the page follows the host.
- Colours in our own code come only from tokens (`bg-card`, `text-muted-foreground`, …). The one exception is `QrCode.tsx`: black modules on white, whatever the theme, because scanners need that contrast.

## CSP and content safety

- `UI_CSP` (`src/webui.js`) and `CONNECT_CSP` (`src/server.js`) are set first in each request handler, so every response carries them (404, 503, 500 and git responses included), together with `nosniff`.
- Neither allows `'unsafe-inline'` styles. So the UI uses no component that injects a `<style>` element: no Radix Dialog, Sheet, Select, ScrollArea or DropdownMenu, and no sonner toasts. Confirmation is inline (Unshare), and feedback is inline text or an `Alert`. React and Radix set `style` through the CSSOM, which the CSP does not block.
- There is no `img-src`: the QR code is SVG elements.
- Content from the backend or a peer (names, paths, URLs, error messages) is always JSX text. The UI renders no link built from content, so there is no `safeHref`. Adding one requires the scheme allowlist from code-conductor's `docs/plugin-ui.md`, Part 2.
- Every request goes through `api()` in `src/lib/api.ts`, the only module that touches the network, with a relative path (`api/…`): inside code-conductor a root-relative `/api/…` would reach code-conductor's API, so `api()` refuses a `/`-led path.
- `api()` sends `Content-Type: application/json` on every request other than GET/HEAD, body or not: the backend refuses a state-changing request without it (see the README's Security notes).

## Interaction rules

- **Busy buttons are `aria-disabled`, not `disabled`** (`ActionButton`). Browsers move focus off a control that becomes `disabled`, so a keyboard user who pressed Fetch, Sync, Clone, Share, Connect or Start/Stop tunnel would land back at the top of the page. `ActionButton` keeps focus on the button, looks disabled, and ignores activation while busy, including a busy submit button's form submission. The Leader checkbox stays enabled while its change is saving and ignores toggles meanwhile, for the same reason.
- `disabled` is kept for controls with nothing to act on: Copy while the value is `—`, and Show QR without a connection string.
- `usePoll` loads status and projects every `POLL_MS`, never two loads at once. A failed refresh keeps the last data (`refreshError`); a refresh asked for during a load runs once more after it.
- Per-row Fetch/Sync/Clone results are kept per (peer, project) across refreshes; the full error text sits in a `<details>` (`ErrorDetails`).

## QR code

- `QrCode.tsx` uses the npm package `qrcode-generator` (error-correction level M, type auto) and draws `getModuleCount()`/`isDark()` as one SVG path inside a 4-module white quiet zone.
- It encodes `qrTextFor(cs)` (`src/lib/connectionString.ts`): `<peer url>/connect#<payload>`, so a phone opens the connect page with the token in the fragment.

## Connection strings

`makeConnectionString` (`src/lib/connectionString.ts`) and `buildConnectionString` (`src/peer.js`) must produce identical bytes: base64url of the UTF-8 JSON, unpadded. Both are tested against `frontend/src/test/cs1-vector.json`.

## Develop

- `npm run dev` serves the UI with hot reload and proxies `/api` to a standalone backend: `PLUGIN_BACKEND` if set, otherwise the default in `frontend/vite.config.mts` (the standalone web UI port).
- `npm run typecheck` runs `tsc -p frontend`.
- Copy a code-conductor component into `src/components/ui/` when first used, never ahead of time, and check it injects no `<style>` (see CSP above).

## Tests

The test map is in the [README](../README.md#tests). Frontend specifics:

- Vitest runs in happy-dom with `fetch` stubbed by `stubApi` (`src/test/api.ts`): a route table keyed `"<METHOD> <url>"`, mutable between polls, with `deferred()` to hold a request in flight. No test talks to a backend.
- Component tests render `App` and query by role, mostly within a section (`getByRole('region', { name: 'Projects' })`).
- `tests/dist.test.mjs` checks the real build, so run `npm install` (or `npm run prepare`) before `npm test`.
