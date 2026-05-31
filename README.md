# code-share

Peer-to-peer read-only Git repo sharing over LAN or the internet. Each party serves their repos read-only and pulls from peers independently — no pushes, ever.

## Key design points

- **Read-only serving**: clone/fetch only; `git push` is rejected at two layers (HTTP 403 + `node-git-server` reject).
- **Pull-only sync**: `sync` only fetches and integrates locally. Nothing is ever pushed to a peer.
- **Nothing shared by default**: a fresh instance exposes zero repos. Use `share` to opt in per project.
- **Multi-project**: one running instance serves all shared repos at their own `/<name>.git` URLs.
- **Single token**: one instance-level token gates access to all served repos.
- **Single connection string**: one `cs1:…` string (shown in the web UI) carries the tunnel URL and token — paste it on the other end to connect.
- **Per-project roles**: leader/follower/symmetric is set independently per shared project, not globally.

## Prerequisites

- **Node.js** (v18+)
- **cloudflared** — required for internet tunnels (`--tunnel cloudflared`, the default). Download from [developers.cloudflare.com](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/). Not needed when using `--tunnel none` or `--tunnel localtunnel`.

## Quick starts

### LAN two-party flow

**Party A** (serves + waits):
```sh
cd ~/cc-projects/code-share
node bin/code-share.js serve --tunnel none
# prints: LAN base URL: http://x:<token>@192.168.x.x:9419
node bin/code-share.js share ../my-project
# Web UI at http://127.0.0.1:9420 — copy the "Connection" string shown there
```

**Party B** (clones, then both stay in sync):
```sh
# Clone the project from A
node bin/code-share.js clone http://x:<token>@192.168.x.x:9419/my-project.git --dir ./my-project
# B also serves
node bin/code-share.js serve --tunnel none
node bin/code-share.js share ./my-project
# Connect using the cs1: string A copied from their web UI
node bin/code-share.js connect cs1:<string-from-A>
```

Both sides can now `sync`:
```sh
node bin/code-share.js sync my-project
```

### Internet / tunnel flow

```sh
node bin/code-share.js serve --tunnel cloudflared
node bin/code-share.js share ../my-project
# Web UI at http://127.0.0.1:9420 — copy the "Connection" string
# Share the cs1:… string with the other party. They run:
node bin/code-share.js connect cs1:<string>
```

No separate token field needed. The `cs1:` string carries everything.

### Multi-project sharing

```sh
node bin/code-share.js share ../project-alpha
node bin/code-share.js share ../project-beta --as beta
node bin/code-share.js list
```

### Per-project leader / follower mode

Roles are set **per project** after connecting, not globally at connect time.

**Via web UI:** After connecting, each shared project row shows a role dropdown — select Leader, Follower, or Symmetric.

**Via CLI** (sets role for all shared projects at connect time, same as selecting via UI):
```sh
node bin/code-share.js connect cs1:<string> --leader    # we are leader for all shared projects
node bin/code-share.js connect cs1:<string> --follower  # we are follower for all shared projects
```

| Role | Sync behavior |
|------|--------------|
| **Symmetric** (default) | Both sides merge with `--no-ff`. Visible merge commits on each sync. |
| **Leader** | Ingests follower's commits via `merge --no-ff`. |
| **Follower** | Fast-forwards to leader's tip. Rebases local commits on top if needed. |

Two peers both claiming leader for the same project → rejected (409).

## CLI reference

| Command | Description |
|---------|-------------|
| `serve [opts]` | Start git server + tunnel + web UI |
| `share <path> [--as name]` | Add a repo to the shared scope |
| `unshare <name>` | Remove a repo from scope |
| `list` | Show shared repos + URLs |
| `clone <url> [--token t] [--dir d]` | Clone a peer project |
| `connect <cs1:string\|url> [--name n] [--leader\|--follower]` | Handshake both directions |
| `sync [project] [--remote r] [--branch b] [--rebase]` | Pull-only sync |
| `status` | Show token, URLs, shared repos, peers |

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
| **Projects** | All git repos under PROJECTS_ROOT — Share/Unshare, per-project role selector, sync state |
| **Connect a Peer** | Paste a peer's `cs1:` connection string + give the peer a local name |
| **Connected Peers** | Each peer with their shared project catalog (fetched live from the peer's `/control/status`) |

**Sync state badge** (per project, after clicking ↕ Sync):
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

## Architecture

```
External HTTP server  0.0.0.0:<port>    ← auth (Basic x:<token>) + receive-pack block
  └─ git.handle(req,res)                ← node-git-server (single process, no proxy)
  └─ /control/register POST             ← peer handshake (accepts projectRoles map)
  └─ /control/status   GET             ← catalog for authed peers

Web UI               127.0.0.1:<uiPort> ← never tunneled, localhost only
  └─ /api/status                        ← config + registry
  └─ /api/projects                      ← scanned git repos
  └─ /api/share|unshare                 ← manage registry
  └─ /api/connect                       ← initiate peer handshake
  └─ /api/project-role                  ← set per-project sync role
  └─ /api/peer-status?peer=<name>       ← proxy to peer's /control/status
  └─ /api/sync-status?project=<name>    ← git fetch + ahead/behind count

Tunnel               (cloudflared/localtunnel) → wraps only the git server port
```

State lives in `data/` inside the code-share project directory (gitignored):
- `data/config.json` — token, ports, tunnel, peer list (url + token per peer), last known URLs
- `data/registry.json` — shared projects: `{ name, path, role, peers[] }` — role is per-project
- `data/serve/<name>.git` → symlink to actual repo (node-git-server root)

Target repos are never modified by code-share (peer git remotes in their `.git/config` are standard git, not code-share files).

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
