# code-share

Peer-to-peer read-only Git repo sharing over LAN or the internet. Each party serves their repos read-only and pulls from peers independently — no pushes, ever.

## Key design points

- **Read-only serving**: clone/fetch only; `git push` is rejected at two layers (HTTP 403 + `node-git-server` reject).
- **Pull-only sync**: `sync` only fetches and integrates locally. Nothing is ever pushed to a peer.
- **Nothing shared by default**: a fresh instance exposes zero repos. Use `share` to opt in per project.
- **Multi-project**: one running instance serves all shared repos at their own `/<name>.git` URLs.
- **Single token**: one instance-level token gates access to all served repos (per-repo tokens are a future enhancement).

## Prerequisites

- **Node.js** (v18+)
- **cloudflared** — required for internet tunnels (`--tunnel cloudflared`, the default). Install via Termux: `pkg install cloudflared`. Not needed when using `--tunnel none` or `--tunnel localtunnel`.

## Quick starts

### LAN two-party flow

**Party A** (serves + waits):
```sh
cd ~/cc-projects/code-share
node bin/code-share.js serve --tunnel none
# prints: LAN base URL: http://x:<token>@192.168.x.x:9419
node bin/code-share.js share ../my-project
```

**Party B** (clones, then both stay in sync):
```sh
# Clone the project from A
node bin/code-share.js clone http://x:<token>@192.168.x.x:9419/my-project.git --dir ./my-project
# B also serves
node bin/code-share.js serve --tunnel none
node bin/code-share.js share ./my-project
# Wire both directions (B connects to A; A gets B's URL via handshake)
node bin/code-share.js connect http://x:<token>@192.168.x.x:9419 --token <token>
```

Both sides can now `sync`:
```sh
node bin/code-share.js sync my-project
```

### Internet / tunnel flow

```sh
node bin/code-share.js serve --tunnel cloudflared
# prints: Tunnel URL: https://xxxx.trycloudflare.com (with token embedded)
node bin/code-share.js share ../my-project
```

Share the tunnel URL + token with the other party. They run `clone` then `connect`. Token is required; wrong/no token → 401.

### Multi-project sharing

```sh
node bin/code-share.js share ../project-alpha
node bin/code-share.js share ../project-beta --as beta
node bin/code-share.js list
# Shows URLs for both projects
```

### Leader / follower mode

```sh
# A declares itself leader at connect time
node bin/code-share.js connect <B's URL> --leader

# Follower B fast-forwards to A's tip on sync
# Leader A ingests B's commits via merge --no-ff
```

**Symmetric mode** (default, no leader declared): both sides merge with `--no-ff`. Each sync is a visible merge commit. Note: if both parties independently resolve the same conflict differently, syncing can surface divergence — resolve manually with `git merge --abort`, fix, then re-sync.

## CLI reference

| Command | Description |
|---------|-------------|
| `serve [opts]` | Start git server + tunnel + web UI |
| `share <path> [--as name]` | Add a repo to the shared scope |
| `unshare <name>` | Remove a repo from scope |
| `list` | Show shared repos + URLs |
| `clone <url> [--token t] [--dir d]` | Clone a peer project |
| `connect <url> [--token t] [--name n] [--leader\|--follower]` | Handshake both directions |
| `sync [project] [--remote r] [--branch b] [--rebase]` | Pull-only sync |
| `status` | Show token, URLs, shared repos, peers |

### `serve` options
| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `9419` | Git server port |
| `--ui-port` | `9420` | Web UI port (localhost only, never tunneled) |
| `--tunnel` | `cloudflared` | `cloudflared`, `localtunnel`, or `none` |
| `--mdns` | off | Advertise via Bonjour/mDNS |
| `--token` | auto-generated | Override the instance token |

## Architecture

```
External HTTP server  0.0.0.0:<port>    ← auth (Basic x:<token>) + receive-pack block
  └─ git.handle(req,res)                ← node-git-server (single process, no proxy)
  └─ /control/register POST             ← peer handshake
  └─ /control/status   GET             ← catalog for authed peers

Web UI               127.0.0.1:<uiPort> ← never tunneled, localhost only

Tunnel               (cloudflared/localtunnel) → wraps only the git server port
```

State lives in `data/` inside the code-share project directory (gitignored):
- `data/config.json` — token, ports, tunnel, peer list, last known URLs
- `data/registry.json` — shared projects with roles and per-project peers
- `data/serve/<name>.git` → symlink to actual repo (node-git-server root)

Target repos are never modified by code-share (peer git remotes in their `.git/config` are standard git, not code-share files).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECTS_ROOT` | parent of code-share dir | Root scanned by the web UI for discoverable git repos |

## Security notes

- The tunnel carries only the git read-only endpoint. The web UI is localhost-only.
- Push is blocked at two independent layers (HTTP server + git server event hook).
- Token auth is enforced before any request is routed, including control endpoints.
- cloudflared must be installed separately (`pkg install cloudflared` on Termux). The app does not download it.
