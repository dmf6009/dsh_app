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
npm install                # ELECTRON_SKIP_BINARY_DOWNLOAD=1 if the CDN is blocked
npm run build              # tsc (main+preload) + vite build (renderer)
npm start                  # full desktop app; runtime auto-starts on launch

npm test                   # codec / process manager / stub / client tests
npm run smoke:protocol     # frame-level demo vs. the reference stub
npm run smoke:app          # boots Electron itself under xvfb, asserts the loop
npm run smoke:dsh          # optional probe of a real dsh desktop profile
```

The child command is chosen at startup:

| env                                   | effect                                    |
| ------------------------------------- | ----------------------------------------- |
| _(unset)_                             | default → `node scripts/stub-runtime.mjs` |
| `DSH_RUNTIME_BIN` + `DSH_RUNTIME_ARGS`| e.g. `dsh --profile desktop --stdio`      |
| `DSH_NODE_BIN`                        | node binary used for the stub             |
| `DSH_MAX_LINE_BYTES`                  | decoder line cap override                 |
| `DSH_SMOKE=1`                         | headless closed-loop self-test, exit code |

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
