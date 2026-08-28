# DSH Desktop — Phase 0 Runtime Prototype (DSHA-3)

Desktop coding agent shell built on Electron + React + TypeScript + Vite.
Phase 0 proves one thing: the **Electron ↔ JSONL ↔ DSH minimal closed loop**.

```
Renderer (React)  --IPC-->  Main process  --JSONL/stdio-->  DSH runtime
                            RuntimeClient                    (stub in P0)
                            ├─ workspace-manager/            (placeholder)
                            ├─ dsh-process-manager.ts        spawn/kill/reap
                            └─ runtime-client.ts             run tracking
```

## Quick start

```bash
npm install                # installs the app AND the @deepseek-ai/dsh runtime together
npm run build              # tsc (main+preload) + vite build (renderer)
npm start                  # full desktop app; runtime auto-starts on launch

npm test                   # codec / process manager / stub / client tests
npm run smoke:protocol     # frame-level demo vs. the reference stub
npm run smoke:app          # boots Electron itself under xvfb, asserts the loop
npm run smoke:dsh          # optional probe of the real dsh desktop profile
```

The child command is chosen at startup:

| env                                   | effect                                    |
| ------------------------------------- | ----------------------------------------- |
| _(unset)_                             | desktop profile → `node scripts/dsh-desktop-profile.mjs`, which speaks Runtime Protocol v1 and executes each run with the bundled dsh CLI's headless mode; falls back to `node scripts/stub-runtime.mjs` when no dsh is installed |
| `DSH_RUNTIME_BIN` + `DSH_RUNTIME_ARGS`| explicit override, e.g. a future native `dsh --profile desktop --stdio` |
| `DSH_NODE_BIN`                        | node binary used for the adapter/stub     |
| `DSH_MAX_LINE_BYTES`                  | decoder line cap override                 |
| `DSH_SMOKE=1`                         | headless closed-loop self-test, exit code |

Notes:

- The desktop profile adapter (`scripts/dsh-desktop-profile.mjs`) resolves its
  dsh CLI in the order: `DSH_DESKTOP_DSH_BIN` → bundled `node_modules/.bin/dsh`
  → `dsh` on PATH. When the official CLI ships a native desktop profile, point
  `DSH_RUNTIME_BIN` at `dsh --profile desktop --stdio` to bypass the adapter.
- The dsh detection (Home banner / Settings → DSH) resolves in the order:
  Settings path override → bundled `node_modules/.bin/dsh` → `dsh` on PATH.
- Smoke (`DSH_SMOKE=1`) and responsive-measure runs always default to the
  deterministic stub runtime so QA stays reproducible; set `DSH_RUNTIME_BIN`
  to point them at a real dsh.

## Plugins（万物皆可插）

Settings → 插件 manages the plugins of the run profile (default `headless`,
overridable via `DSH_DESKTOP_PLUGIN_PROFILE`): listing reads the profile
manifest (`~/.dsh/profiles/<profile>/package.json` — `dsh.profile.bundles` is
the ordered boot stack), install/remove goes through the official
`dsh plugin --profile <p> add|remove` CLI (pnpm forward + bundle-list
reconcile). `@deepseek-ai/dsh-base` is protected from removal. Plugin changes
apply to the next agent run — the runtime spawns dsh per run, no app restart
needed. Design spec: `docs/design/mvp-pages-ui-ux-spec.md` §11.

## What works today (Phase 0 scope)

- Runtime Protocol v1: typed JSONL frames, tolerant decoder, overlong-line
  protection (`docs/runtime-protocol-v1.md`)
- Process manager: spawn → ready handshake, SIGTERM→SIGKILL teardown with no
  residual processes, crash surfaced as a recoverable `error` frame, restart
- Renderer chat page: streaming assistant text, collapsible tool output,
  Send⇄Stop toggle, cancel restores input after `run_cancelled`, crash banner
  with restart button

Explicitly out of scope for this phase: approval dialogs, diff viewer, session
persistence, settings/provider management, multi-provider, three-column layout.

## Layout

```
src/shared/protocol/    types.ts · codec.ts        # protocol layer (shared)
src/shared/desktop-api  IPC surface contract
src/main/runtime/       dsh-process-manager.ts · runtime-client.ts
src/main/workspace-manager/                        # §30 slot, Phase 0 placeholder
src/main/index.ts       entry + IPC wiring (+ DSH_SMOKE harness)
src/preload/index.ts    contextBridge API
src/renderer/src/App.tsx                           # single-window chat page
scripts/stub-runtime.mjs                           # reference stub runtime
scripts/smoke-*.mjs                                # smoke entry points
tests/                                             # vitest suites
```

## Environment notes (this VM)

- npm cache was root-owned → use `--cache "$PWD/.npm-cache"`.
- GitHub release CDN unreachable → `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`,
  then fetch the binary via mirror:
  `cd node_modules/electron && XDG_CACHE_HOME="$PWD/../../.cache" \
   ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ node install.js`
- Headless runs need `xvfb-run -a` and Chromium flags `--no-sandbox
  --disable-dev-shm-usage`; `npm run smoke:app` applies both automatically.
