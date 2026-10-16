# code-share

Peer-to-peer read-only Git repo sharing over LAN or the internet. Each party serves their repos read-only and pulls from peers independently — no pushes, ever.

## Key design points

- **Read-only serving**: clone/fetch only; `git push` is rejected at two layers (HTTP 403 + `node-git-server` reject).
- **Pull-only sync**: `sync` only fetches and integrates locally. Nothing is ever pushed to a peer.
- **Nothing shared by default**: a fresh instance exposes zero repos. Use `share` to opt in per project.
- **Multi-project**: one running instance serves all shared repos at their own `/<name>.git` URLs.
- **Single token**: one instance-level token gates access to all served repos.
- **Single connection string**: one `cs1:…` string (shown in the web UI **and** the CLI `status` command) carries the tunnel URL and token — paste it on the other end to connect.
- **Per-project leader flag**: each shared project has a boolean "am I the leader?" (default false). Sync mode is derived at sync time by comparing both sides' flags.

## Prerequisites

- **Node.js** 22.12 or newer.
- **`npm install`** once in the checkout: it installs the dependencies and builds the web UI and the connect page into `frontend/dist/` (untracked). Until it has run, both pages answer a plain-text 503 `UI not built — run npm install`.
- **cloudflared** — required for internet tunnels (`--tunnel cloudflared`, the default). Download from [developers.cloudflare.com](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/). Not needed when using `--tunnel none` or `--tunnel localtunnel`.

## Quick starts

### LAN two-party flow

**Party A** (serves + shares):
```sh
cd ~/cc-projects/code-share
node bin/code-share.js serve --tunnel none
# prints: LAN base URL: http://x:<token>@192.168.x.x:9419
node bin/code-share.js share ../my-project --leader   # --leader optional; default is follower
# Copy the cs1: Connection string — shown by the web UI (http://127.0.0.1:9420)
# and by `node bin/code-share.js status`.
```

**Party B** (connects, clones, then both stay in sync):
```sh
node bin/code-share.js serve --tunnel none
# Connect using the cs1: string from A (shown in A's web UI or `status`)
node bin/code-share.js connect cs1:<string-from-A>
# Clone by peer name (default 'peer') + project name — no URL/token to paste
node bin/code-share.js clone peer my-project
# Share it back (sets this side's per-project leader flag; default follower)
node bin/code-share.js share ./my-project --follower
```

Both sides can now `sync`:
```sh
node bin/code-share.js sync my-project
```

> **LAN IP note:** in normal multi-host use the LAN base URL contains the machine's
> real LAN IP (e.g. `192.168.x.x`). It shows `127.0.0.1` only when both peers run on
> the **same host** (e.g. local testing on one machine).

### Internet / tunnel flow

> **Prerequisites:** `serve` must be running on **both** sides before `connect` or `share`.
> When connecting to an internet (cloudflared) peer, your own `serve` must also have
> a live tunnel (`--tunnel cloudflared`) so the peer can store a routable URL for you.

For two-way internet sync, **both** parties must run their own tunnel so each side
has a publicly reachable URL to advertise during the handshake.

**Party A** (shares first):
```sh
node bin/code-share.js serve --tunnel cloudflared
node bin/code-share.js share ../my-project
# Copy the cs1: Connection string (web UI or `status`) and send it to Party B.
```

**Party B** (connects):
```sh
node bin/code-share.js serve --tunnel cloudflared
node bin/code-share.js connect cs1:<string-from-A>
node bin/code-share.js clone peer my-project
node bin/code-share.js share ./my-project
```

From that single `connect`, both directions are wired automatically: the client
passes its own tunnel URL to the server during the handshake, so the server stores
a routable address for the client too. Both sides can then `sync` over the internet.
No separate token field needed. The `cs1:` string carries everything.

### Multi-project sharing

```sh
node bin/code-share.js share ../project-alpha
node bin/code-share.js share ../project-beta --as beta
node bin/code-share.js list
```

## Sync modes & conflict handling

### Per-project leader flag and sync mode

Each shared project has a single boolean: **"am I the leader for this project?"** (default false). There is no stored "follower" or "symmetric" value. The sync strategy is computed at sync time by comparing both sides' current leader flag.

**Via web UI:** Each shared project row shows a **Leader** checkbox. Tick it to mark this side as the leader for that project.

**Via CLI:** set the flag per project at `share` time (default follower):
```sh
node bin/code-share.js share <path> --leader     # leader=true for this project
node bin/code-share.js share <path> --follower   # leader=false (the default)
```

| My `leader` | Peer `leader` | Derived mode | Sync behavior |
|-------------|---------------|--------------|---------------|
| false | false | Symmetric | Both sides `merge --no-ff`. Visible merge commits on each sync. |
| true  | true  | Symmetric | Both sides `merge --no-ff`. |
| true  | false | Leader side | I ingest peer's commits via `merge --no-ff`. |
| false | true  | Follower side | I fast-forward to peer's tip. Rebases local commits on top if needed. |

The peer's current leader flag is fetched live from their `/control/status` at sync time, with a fallback to the value stored at connect time if the peer is unreachable.

### Peer remotes

code-share wires a standard git remote into each shared project's `.git/config` so that `sync` and manual git commands can reach a peer without reconstructing a URL.

**Remote name:** the peer's local name — `peer` by default, set with `connect --name <n>`.  
**Remote URL:** token embedded in Basic-auth form: `http://x:<token>@host:port/<project>.git`.

The remote is added (or updated, idempotently) at three moments:

1. **`connect`** — wired onto every project you are currently sharing.
2. **`share` while peers are connected** — wired for every already-connected peer onto the newly-shared project.
3. **Inbound peer connection** (`POST /control/register`) — wired for the connecting peer onto your currently-shared projects.

`sync` defaults to `remote = 'peer'`, so `sync <project>` is equivalent to `git fetch peer` followed by the applicable merge or rebase.

To inspect or use the remote URL for manual git actions:
```sh
git -C <repo> remote get-url peer   # authed URL for this project
git -C <repo> remote -v             # all wired peer remotes
```

### Conflict handling

On any conflict, `sync` aborts the in-progress git operation automatically, leaving the working tree clean and the branch tip unchanged. Exit code is `1`. No manual cleanup needed.

| Sync mode | Abort | Output |
|-----------|-------|--------|
| Symmetric or leader ingest | `git merge --abort` | `Sync failed: Merge conflict. Aborted cleanly. Conflicting files:` + file list |
| Follower (rebase fallback) | `git rebase --abort` | `Sync failed: Rebase conflict on follower sync. Aborted cleanly. Conflicting files:` + file list |
| `--rebase` flag | `git rebase --abort` | `Sync failed: Rebase conflict. Aborted cleanly. Conflicting files:` + file list |

The follower path logs `Follower fast-forward sync...` then, if fast-forward fails, `Cannot fast-forward; rebasing local commits on top of leader tip...` before rebasing.

**Followers must rebase, never merge.** When you are the follower for a project (your `leader` flag is false and the peer's is true) and a sync conflicts, you are required to resolve it by **rebasing your local commits onto the leader's tip** — do *not* fall back to a merge. Only the leader (or symmetric peers) may create merge commits; the follower keeps a linear history rooted on the leader's branch. This is exactly what automated `sync` enforces (it rebases on the follower path and only ever runs `merge --no-ff` for symmetric/leader-ingest modes), and it must hold for manual reconciliation too.

**To reconcile manually after a conflict** (`peer` is the remote name wired by code-share; see [Peer remotes](#peer-remotes)):
```sh
git -C <repo> remote get-url peer          # print the authed URL if needed
git -C <repo> fetch peer

# Follower (your leader=false, peer leader=true): REBASE only — never merge.
git -C <repo> rebase peer/<branch>
# resolve conflicts in editor, then:
git -C <repo> add <files> && git -C <repo> rebase --continue

# Leader / symmetric only: a merge commit is allowed.
git -C <repo> merge --no-ff peer/<branch>
# resolve conflicts in editor, then:
git -C <repo> add <files> && git -C <repo> commit --no-edit
```

## CLI reference

| Command | Description |
|---------|-------------|
| `serve [opts]` | Start git server + tunnel + web UI |
| `share <path> [--as name] [--leader\|--follower]` | Add a repo to the shared scope (sets per-project leader flag; default follower) |
| `unshare <name>` | Remove a repo from scope |
| `list` | Show shared repos + URLs |
| `clone <peer> <project> [--dir d]` | Clone a project from a connected peer (run `connect` first) |
| `connect <cs1:string\|url> [--name n]` | Handshake both directions |
| `sync [project] [--remote r] [--branch b] [--rebase]` | Pull-only sync (`--branch`: one plain branch name, see Security notes) |
| `status` | Show token, URLs, `cs1:` connection string, shared repos, peers |

### `connect` input formats

| Format | Example |
|--------|---------|
| `cs1:` connection string (recommended) | `connect cs1:eyJ…` |
| Plain URL with embedded credentials | `connect http://x:token@host:9419` |
| Plain URL + `--token` flag | `connect http://host:9419 --token abc123` |

The URL must be `http:` or `https:`, and `--name` must match `PEER_NAME_RE` in `src/names.js` (letters, digits, `.`, `_`, `-`, starting with a letter or digit); otherwise `connect` stops with `Invalid peer URL` or `Invalid peer name`.

### `serve` options
| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `9419` | Git server port |
| `--ui-port` | `9420` | Web UI port (localhost only, never tunneled) |
| `--tunnel` | `cloudflared` | `cloudflared`, `localtunnel`, or `none` |
| `--mdns` | off | Advertise via Bonjour/mDNS |
| `--token` | auto-generated | Override the instance token |

A tunnel can also be started or stopped later, without restarting `serve`, via the **Start tunnel** / **Stop tunnel** button in the web UI's "Your Link" section (see below).

## Web UI

Open `http://127.0.0.1:<uiPort>` (default 9420) while `serve` is running.

- **Build and design**: the web UI and the connect page (the QR landing page the git server serves at `/connect`) are built from `frontend/` with React, Tailwind v4 and code-conductor's components. See [docs/frontend.md](docs/frontend.md) for the stack, the build, serving, CSP and the interaction rules.
- **Theme**: inside code-conductor the web UI follows its light/dark theme live (the host's `/pluginTheme.css`, with its Geist fonts). Standalone, and always on the connect page, the pages use a bundled snapshot of code-conductor's palette, follow the OS light/dark setting live, and use the system font. There is no theme toggle of the plugin's own.
- **Buttons** use code-conductor's variants: `default` (filled) only for **Connect**, the form's submit; `destructive` for **Stop tunnel** and the confirming **Unshare**; `outline` for Share, Unshare, Start tunnel, Show QR, Fetch, Sync and Clone; `ghost` for Copy and Cancel; `secondary` for Hide QR (the toggle's on state).
- **Copy** is disabled while a value is `—`. Where the browser refuses the clipboard, it selects the text instead and says "Couldn't copy — text selected".
- **Errors** show inline in their section, never as browser dialogs. A section whose data failed to load offers **Retry**; a failed 15 s refresh keeps the last data and says it couldn't refresh.
- **Keyboard**: every control is reachable with Tab and shows a focus ring. A busy button keeps focus and ignores presses until its request finishes.

| Section | What it shows |
|---------|--------------|
| **Your Link** | LAN URL, Tunnel URL, and the shareable `cs1:` Connection string (copy this for peers). A **Start tunnel** / **Stop tunnel** button brings up (or tears down) a cloudflared tunnel while `serve` keeps running — no restart needed. Starting can take up to ~30s (the button shows a busy state); the Tunnel URL and `cs1:` string update live once it's up. A **Show QR** button renders the Connection string as a QR code (toggle to hide) so a phone on the same LAN can scan it instead of copy/pasting; disabled until a valid Connection string exists. The QR opens the peer's `/connect` page, which shows the `cs1:` string with its own Copy button. |
| **Projects** | All git repos under PROJECTS_ROOT — Share/Unshare, per-project Leader checkbox. **Unshare** asks inline ("Unshare <name>?", Cancel / Unshare; Esc cancels) |
| **Connect a Peer** | Paste a peer's `cs1:` connection string (or an authed URL) + give the peer a local name; Enter submits. The string field clears on success, since it carries the peer's token |
| **Connected Peers** | Per peer, for every project both sides share (live peer catalog ∩ local registry, independent of registry peer-wiring state): a **↻ Fetch button** (checks ahead/behind status only, no repo changes), a **↕ Sync button** (performs a real pull-only sync — fetch + merge/rebase, never pushes — then refreshes the badge), and an ahead/behind badge. A **Clone button** is shown instead for projects the peer exposes that you don't have locally. Before the peer answers, the projects already wired to it are listed; an unreachable peer with none reads `Offline: <error>` |

**Sync state badge** (per syncable project under each peer, updates after clicking either ↻ Fetch or ↕ Sync):
- `✓ in sync` — identical tips
- `↑N ahead` — you have N commits the peer doesn't
- `↓N behind` — peer has N commits you don't
- `↕ diverged` — both ahead and behind
- `sync failed`, `err` (Fetch) or `clone failed` — the attempt errored (e.g. a merge/rebase conflict); open **Details** beside the badge for the full message, including any conflicting file list
- A badge stays across the 15 s refresh until the next Fetch, Sync or Clone on that row.
- With both sides followers (symmetric mode), a Sync creates a merge commit, so the badge then reads `↑1 ahead` until the peer syncs too.

**Known limitation**: the connect page opened over plain-http LAN is not a secure context, so its browser offers no Clipboard API. **Copy** there selects the `cs1:` text for a manual copy instead.

## Tests

```sh
npm install   # once: dev dependencies and the frontend/dist build the tests read
npm test      # node --test (each test bounded by --test-timeout), then tsc -p frontend, then vitest
```

| File | Guards |
|---|---|
| `tests/static.test.mjs` | `src/static.js`: what each server may serve from `frontend/dist` (`serveUi`, `serveConnect`, `connectAssets`), the 503 while unbuilt |
| `tests/webui.test.mjs` | Web UI server: `UI_CSP` and `nosniff` on every response, host URLs 404, a handler error is a 500 the server survives |
| `tests/gitserver.test.mjs` | Git server: `/connect` and its files public, everything else token-gated, `CONNECT_CSP` and `nosniff` on every response |
| `tests/dist.test.mjs` | The real build: servable file names, no inline script/style, relative URLs, head order, connect page loads only public files |
| `tests/frontend-theme.test.mjs` | Theme wiring: the `@layer base` fallback, tokens only (no literal colours), no theme control besides `public/theme-init.js` |
| `tests/connection-string.test.mjs` | `buildConnectionString` (`src/peer.js`) against the vector in `frontend/src/test/cs1-vector.json`, which the UI's tests share |
| `tests/traversal.test.mjs` | Peer-supplied names and URLs (`src/names.js`): unsafe clone names refused with nothing created, served links kept inside `data/serve`, peer names never reach a shell or a git option, peer URLs http(s) only, git routes single-segment only; argv-form `sync` still merges and aborts conflicts cleanly |
| `tests/limits.test.mjs` | `LIMITS`: a stalled peer never blocks the servers and times out (git and HTTP), a flooding peer's reply is cut off, connect survives a stalled status, oversized bodies get 413 on both servers |
| `tests/csrf.test.mjs` | The web UI's JSON gate: text/plain and bodiless POSTs get 415 with no side effect; JSON requests and the MCP bridge's requests still work |
| `tests/gitserver-abort.test.mjs` | The git server survives a reset in-flight request without leaking `git-upload-pack` and logs an aborted body as one line, and answers a malformed request with 400 |
| `tests/git-deadlines.test.mjs` | `runGit`: the deadline kills git's whole process group, `GIT_STALL_SECONDS` aborts a stalled transfer, output keeps its tail; a failed clone removes only what it created; the leader-flag lookup is bounded |
| `tests/register-gate.test.mjs` | `/control/register` refuses browser-shaped requests (403) and non-JSON ones (415), and still accepts the released peer client |
| `tests/serve-signal.test.mjs` | SIGTERM to `serve` (a copy of the backend in a temp dir) exits promptly and leaves no git process behind |
| `tests/tunnel-check.test.mjs` | `ensureCloudflared` gives up after `CLOUDFLARED_CHECK_TIMEOUT_MS`, against fake `cloudflared` scripts only (no tunnel) |
| `tests/noshell.test.mjs` | Git runs as `spawn('git', argv)` with no shell: a shell-active project name clones without side effect; unsafe branches are refused before any git runs |
| `tests/frontend-security.test.mjs` | Source guards over `frontend/`: no raw-HTML/eval sinks, no `style`/`href` props in own code, no storage or `window.parent`, only `src/lib/api.ts` touches the network and every `api()` path is a literal `api/…`; each sweep is proven against a planted offender |
| `frontend/src/**/*.test.{ts,tsx}` | Vitest (happy-dom, `fetch` stubbed, no backend): every section's states and actions with their exact request bodies, polling, the QR matrix, hostile content rendered as text, the connect page, `theme-init.js` |

- Tests never start a real tunnel: `tests/_backend.mjs` replaces `src/tunnel.js` before the backend loads, and points `PROJECTS_ROOT` at a temporary directory.
- `tests/_isolatedData.mjs` gives a test file an in-memory config and registry and its own `data/serve`, so no test touches the checkout's `data/`.
- Frontend test specifics: [docs/frontend.md](docs/frontend.md#tests).

## Connection string format

The `cs1:` string is a base64url-encoded JSON payload:

```
cs1:<base64url({"url":"https://host.trycloudflare.com","token":"<hex>"})>
```

- The embedded URL is credential-free (no `x:token@` prefix).
- The token is the peer's server token for authentication.
- Version prefix `cs1:` identifies the format for forward compatibility.

Both the web UI ("Your Link") and the CLI `status` command print the assembled string. Each prefers the tunnel URL over the LAN URL and strips embedded credentials before encoding.

## Architecture

```
External HTTP server  0.0.0.0:<port>    ← auth (Basic x:<token>) + receive-pack block
  └─ /connect, /theme-init.js, /assets/*  ← connect page and only the files it loads (frontend/dist manifest), no auth
  └─ /<name>.git/{info/refs,git-upload-pack,HEAD}  ← git.handle(req,res), node-git-server (single process, no proxy); any other path is a 404 (GIT_ROUTE_RE)
  └─ /control/register POST             ← peer handshake (accepts projectLeaders map)
  └─ /control/status   GET             ← catalog for authed peers (exposes per-project leader boolean)

Web UI               127.0.0.1:<uiPort> ← never tunneled, localhost only
  └─ /api/health                        ← cheap liveness probe, no auth/side effects (no token in response)
  └─ /api/status                        ← config + registry (includes the plaintext token)
  └─ /api/projects                      ← scanned git repos
  └─ /api/share|unshare                 ← manage registry
  └─ /api/connect                       ← initiate peer handshake
  └─ /api/project-leader                ← set per-project leader boolean
  └─ /api/peer-status?peer=<name>       ← proxy to peer's /control/status
  └─ /api/sync-status?project=<name>    ← git fetch + ahead/behind count (self-wires the peer remote)
  └─ /api/sync                          ← pull-only sync (fetch + merge/rebase, never pushes); same logic as CLI `sync` / MCP `sync` tool
  └─ /api/clone                         ← clone a peer's project into PROJECTS_ROOT, register + wire peer remote
  └─ /api/tunnel/start                  ← start a tunnel while serve is running (body: {type?}, default cloudflared)
  └─ /api/tunnel/stop                   ← stop the active tunnel, back to LAN-only
  └─ /api/mcp                           ← MCP tool bridge (status/share/sync), see "Run as a code-conductor plugin"
  └─ /, /index.html, /theme-init.js, /assets/*  ← the built UI (frontend/dist); anything else is a 404

Tunnel               (cloudflared/localtunnel) → wraps only the git server port
```

State lives in `data/` inside the code-share project directory (gitignored):
- `data/config.json` — token, ports, tunnel, peer list (url + token per peer), last known URLs
- `data/registry.json` — shared projects: `{ name, path, leader, peers[] }` — `leader` is a boolean per project; `peers[].leader` stores the last-known leader flag for each peer
- `data/serve/<name>.git` → symlink to actual repo (node-git-server root)

code-share never touches the working tree or commit history of shared repos. It does add a `peer` git remote to each repo's `.git/config` (standard git remote config, not code-share-managed state — removable with `git remote remove peer`).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECTS_ROOT` | parent of code-share dir | Root scanned by the web UI for discoverable git repos |
| `PORT` | (unset) | When set, overrides `uiPort` for that run only (see "Run as a code-conductor plugin"). Never affects the git server port. |
| `CONDUCTOR_PLUGIN_ID` | (unset) | When set, `serve` defaults the tunnel to `none` for that run only, instead of the persisted default. |

## Run as a code-conductor plugin

code-share can be installed as a code-conductor plugin via the `conductor.plugin.json` manifest at the repo root. The conductor supervises `node bin/code-share.js serve` as the backend, iframes the web UI through its reverse proxy at `/plugins/code-share/...`, and forwards three MCP tools (`code-share__status`, `code-share__share`, `code-share__sync`) to the existing `status`/`share`/`sync` logic.

- **UI port**: `serve` binds the web UI to `$PORT` when the conductor sets it (precedence: explicit `--ui-port` flag > `$PORT` > persisted `data/config.json` default of `9420`). Neither `$PORT` nor a bare plugin launch ever persists a new default — a later standalone `serve` still uses whatever was last explicitly configured. The git server port (`--port`, default `9419`) is completely independent of `$PORT`.
- **Tunnel**: a plugin launch (detected via `$CONDUCTOR_PLUGIN_ID`, which the conductor always injects) defaults the tunnel to `none` for that run only — the persisted `data/config.json` tunnel default is untouched, so standalone runs are unaffected.
- **Health check**: the manifest's `healthPath` is `/api/health`, a dedicated no-op endpoint (distinct from `/api/status`, which echoes the plaintext instance token and isn't suitable for an arbitrary prober).
- **Known limitation**: like the rest of the web UI, `/api/*` (including `/api/mcp`) has no authentication of its own beyond the web UI's loopback-only binding when run standalone. Once proxied by the conductor, this surface is reachable to anyone who can reach the conductor's own UI/MCP bridge — consistent with code-conductor's model of treating enabled plugins as trusted code running with the conductor's own privileges, not a gap newly introduced by this integration.

## Security notes

- The tunnel carries only the git read-only endpoint. The web UI is localhost-only and is never tunneled — except indirectly through the code-conductor reverse proxy when installed as a plugin (see above).
- Push is blocked at two independent layers (HTTP server + git server event hook).
- Token auth is enforced before any request is routed, including control endpoints. The exceptions are the connect page and the files it loads; any other `/assets/*` path is a plain 404.
- Both servers send a strict Content-Security-Policy and `X-Content-Type-Options: nosniff` on every response: `UI_CSP` in `src/webui.js`, `CONNECT_CSP` in `src/server.js`.
- Strings a peer supplies never reach a path outside its root, a shell or a git option (`src/names.js`):
  - **Project names** from a peer's catalog (Clone) must be one plain path segment: no `/` or `\`, no leading `.` or `-`, no control characters (`checkProjectName`). The clone lands directly inside `PROJECTS_ROOT` (`childPath`). A refused name is a 400 shown as `clone failed`.
  - **Peer names** become git remote names, so they must match `PEER_NAME_RE`: letters, digits, `.`, `_`, `-`, starting with a letter or digit. This applies to `connect --name`, the web UI's peer name, and a peer registering itself.
  - **Peer URLs** must be `http:` or `https:` (`checkPeerUrl`).
  - **Branches** (`sync --branch`, `POST /api/sync`, the MCP `sync` tool) must be one plain branch name (`checkBranch`, `BRANCH_RE`): never an option, a refspec or a range.
  - Every git command runs in argv form with `--` before positional arguments, through `runGit` in `src/git.js`; nothing goes through a shell.
  - A stored peer entry that is not usable (a name outside `PEER_NAME_RE` or a non-http(s) URL) is ignored with a logged error when a project is shared or cloned; reconnect that peer under a valid name.
  - Any project name (CLI `share --as`, the web UI, the MCP `share` tool) must keep its `data/serve/<name>.git` link directly inside `data/serve` (`checkShareName`).
- Nothing a peer or client does can stall or exhaust the servers. Every bound is named in `LIMITS` (`src/limits.js`):
  - git runs asynchronously, so a slow fetch or clone never blocks either server. A git command is killed, with its transport helpers, after `GIT_TIMEOUT_MS` (`git <command> timed out after <n>s`), and git itself aborts a transfer stalled for `GIT_STALL_SECONDS` (`Operation too slow`). Each output stream keeps its last `GIT_OUTPUT_MAX_CHARS`.
  - a clone that fails for any reason removes the directory it created (never one that already existed), so the name can be retried.
  - git commands still running when code-share exits (Ctrl-C, SIGTERM, or any exit) are killed with it.
  - an HTTP call to a peer (register, status, peer-status) must finish within `PEER_HTTP_TIMEOUT_MS` (`Peer did not answer within <n>s`); the leader-flag lookup during sync within `LEADER_FLAG_TIMEOUT_MS`, after which sync uses the stored flag. A reply over `PEER_RESPONSE_MAX_BYTES` is cut off (`Peer reply larger than <n> bytes`).
  - a request body over `REQUEST_BODY_MAX_BYTES` gets a 413 on either server, and the connection is closed.
  - `cloudflared --version`, checked before a tunnel starts, must answer within `CLOUDFLARED_CHECK_TIMEOUT_MS`.
  - the git server survives a client that aborts mid-request (one log line) or sends a malformed request (400), and ends the `git-upload-pack` it had started.
- The web UI changes state only for a request that declares `Content-Type: application/json` (any request other than GET or HEAD, body or not); anything else gets a 415 `{"error": "Content-Type must be application/json"}`. A page on another site can send a text/plain or bodiless POST to `127.0.0.1` without a CORS preflight, but not a JSON one. code-conductor's MCP bridge sends `application/json`.
- The git server's `/control/register` (token-authenticated) refuses a request carrying an `Origin` header, or a `Sec-Fetch-Site` other than `same-origin` or `none`, with a 403, and one without `Content-Type: application/json` with a 415. A browser that cached the token as a Basic credential for that origin could otherwise be made to register a peer from another site; code-share peers send JSON with neither header.
- The `cs1:` connection string embeds the token — treat it like a password and share only over secure channels.
- cloudflared must be installed separately (see Prerequisites). The app does not download it.

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). Copyright © 2026 UnmanagedCode. See the [LICENSE](LICENSE) file for details.
