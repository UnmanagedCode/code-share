@CONVENTIONS.md

- In a worktree, `node_modules` may be a symlink to the main checkout's. Never `npm install` through it: `rm node_modules` (the link only, never `-r`), then `npm install`. `npm run prepare` through the link is fine.
- Never start a real tunnel (`cloudflared` may be on PATH): backend tests import `tests/_backend.mjs`, and browser checks route-stub `api/tunnel/*` before navigating.
