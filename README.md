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

- **Node.js** (v18+)
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

```sh
node bin/code-share.js serve --tunnel cloudflared
node bin/code-share.js share ../my-project
# Copy the cs1: Connection string — shown in the web UI (http://127.0.0.1:9420)
# or by `node bin/code-share.js status`. Share it with the other party. They run:
node bin/code-share.js connect cs1:<string>
node bin/code-share.js clone peer my-project
```

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
| `sync [project] [--remote r] [--branch b] [--rebase]` | Pull-only sync |
| `status` | Show token, URLs, `cs1:` connection string, shared repos, peers |

### `connect` input formats

| Format | Example |
|--------|---------|
| `cs1:` connection string (recommended) | `connect cs1:eyJ…` |
| Plain URL with embedded credentials | `connect http://x:token@host:9419` |
| Plain URL + `--token` flag | `connect http://host:9419 --token abc123` |

### `serve` options
| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `9419` | Git server port |
| `--ui-port` | `9420` | Web UI port (localhost only, never tunneled) |
| `--tunnel` | `cloudflared` | `cloudflared`, `localtunnel`, or `none` |
| `--mdns` | off | Advertise via Bonjour/mDNS |
| `--token` | auto-generated | Override the instance token |

## Web UI

Open `http://127.0.0.1:<uiPort>` (default 9420) while `serve` is running.

| Section | What it shows |
|---------|--------------|
| **Your Link** | LAN URL, Tunnel URL, and the shareable `cs1:` Connection string (copy this for peers) |
| **Projects** | All git repos under PROJECTS_ROOT — Share/Unshare, per-project Leader checkbox |
| **Connect a Peer** | Paste a peer's `cs1:` connection string + give the peer a local name |
| **Connected Peers** | Each peer with syncable projects (Sync button + ahead/behind badge per project) and any additional projects the peer exposes |

**Sync state badge** (per syncable project under each peer, after clicking ↕ Sync):
- `✓ in sync` — identical tips
- `↑N ahead` — you have N commits the peer doesn't
- `↓N behind` — peer has N commits you don't
- `↕ diverged` — both ahead and behind

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
  └─ git.handle(req,res)                ← node-git-server (single process, no proxy)
  └─ /control/register POST             ← peer handshake (accepts projectLeaders map)
  └─ /control/status   GET             ← catalog for authed peers (exposes per-project leader boolean)

Web UI               127.0.0.1:<uiPort> ← never tunneled, localhost only
  └─ /api/status                        ← config + registry
  └─ /api/projects                      ← scanned git repos
  └─ /api/share|unshare                 ← manage registry
  └─ /api/connect                       ← initiate peer handshake
  └─ /api/project-leader                ← set per-project leader boolean
  └─ /api/peer-status?peer=<name>       ← proxy to peer's /control/status
  └─ /api/sync-status?project=<name>    ← git fetch + ahead/behind count

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

## Security notes

- The tunnel carries only the git read-only endpoint. The web UI is localhost-only and is never tunneled.
- Push is blocked at two independent layers (HTTP server + git server event hook).
- Token auth is enforced before any request is routed, including control endpoints.
- The `cs1:` connection string embeds the token — treat it like a password and share only over secure channels.
- cloudflared must be installed separately (see Prerequisites). The app does not download it.
