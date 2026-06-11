# Node 26 + pnpm migration (app/)

Date: 2026-06-11. Host: macOS arm64, Node 26.0.0, pnpm 10.4.0.

## What changed

| Package | Before | After | Why |
|---|---|---|---|
| better-sqlite3 | ^11.3.0 | ^12.10.0 | 12.10.0 is the first release with Node 26 prebuilds (PR WiseLibs/better-sqlite3#1468); engines `20.x … 26.x`. 11.x used V8 APIs removed in Node 26 (`GetPrototype`, `Context::GetIsolate`, `PropertyCallbackInfo::This`), so its host-Node compile crashed the whole npm install. |
| node-pty | ^1.0.0 | ^1.1.0 | N-API based (node-addon-api ^7), so ABI-stable; 1.1.0 picks up two years of fixes. Verified it compiles and spawns inside Electron 32. |
| electron-rebuild | ^3.2.9 | removed | Deprecated; crashes under Node 26 (`require is not defined in ES module scope` via hoisted yargs). |
| @electron/rebuild | (transitive) | ^4.0.4 (direct devDep) | Maintained successor; engines `>=22.12.0`; provides the same `electron-rebuild` bin, so the `rebuild` script is unchanged. Verified `pnpm run rebuild` force-compiles both natives from source against Electron 32 headers under Node 26. |
| vitest | ^4.1.8 | ^3.2.6 | vitest 4 peer-requires vite ^6/^7/^8 and imports `vite/module-runner`, which vite 5 doesn't export. It only worked under npm because npm nested a private vite 7 copy inside vitest; pnpm resolves peers honestly and the suite crashed at startup. vitest 3 supports vite 5. The alternative (vite 5→7 + electron-vite 2→5) touches the production build pipeline and was out of scope. |
| electron | ^32.1.2 (kept) | — | **Decision: keep Electron 32.** Natives are rebuilt against its ABI (modules 128), so host Node 26 is orthogonal once the rebuild toolchain works. Nothing forces a bump. Note: better-sqlite3 12.10.0 ships no Electron 32 prebuilds (EOL), so `install-app-deps` compiles it from source — works, adds a few seconds to install. |
| electron-builder | ^25.0.5 (kept) | — | 25.1.8 runs `install-app-deps` cleanly under Node 26; no bump needed. |

## pnpm migration

- `package-lock.json` deleted; `pnpm-lock.yaml` generated.
- `app/.npmrc`: `node-linker=hoisted` — electron-builder/@electron/rebuild expect an npm-style flat `node_modules`; pnpm's default symlink layout breaks them.
- `pnpm.onlyBuiltDependencies: ["electron", "esbuild"]` — pnpm 10 blocks dependency build scripts by default. `electron` **must** stay listed or its binary never downloads (→ `Error: Electron uninstall`). better-sqlite3/node-pty are deliberately *not* listed: their own install scripts would build for host Node, which is wasted work — the project `postinstall` (`electron-builder install-app-deps`) builds them for Electron's ABI, which is the only binary the app uses.

## Toolchain pins

- `engines.node: ">=22.12.0"` — floor set by @electron/rebuild; verified working on 26.
- `.nvmrc`: `26`.
- `packageManager: "pnpm@10.4.0"`.

## Acceptance results (fresh `rm -rf node_modules` on Node 26.0.0)

- `pnpm install` — clean, 9s; natives rebuilt against Electron 32.3.3 by postinstall. ✅
- `pnpm run typecheck` — clean. ✅
- `pnpm test` — 15/15 passing (vitest 3.2.6). ✅
- `pnpm run build` — main + preload + renderer built. ✅
- `pnpm run dev` — window opens, no render-process-gone; `~/.baton/baton.db` WAL actively written during the run (better-sqlite3 live under Electron); sessions respawned through node-pty. ✅
- ABI proof: a direct Electron harness created a DB via better-sqlite3 and echoed through a node-pty spawn under `electron 32.3.3, modules 128`. (A bare `require('better-sqlite3')` under host Node succeeding is a red herring — the native binding loads lazily on first `Database` construction.)

## Known residuals

- vite 5 / electron-vite 2 are now the oldest pieces of the toolchain. A future vite 7 + electron-vite 5 + vitest 4 bump is the natural next step but touches the build pipeline, so it was intentionally excluded here.
- 13 deprecated transitive subdependencies warned by pnpm (glob 7/8, rimraf 3, etc.) — all under electron-builder/@electron/rebuild trees; harmless.
