// First-run build of the native helper. The plugin ships only helper/island.swift (the directory
// rejects executables); this compiles it with the Xcode Command Line Tools into a per-user cache
// keyed by the source hash. A binary built on this Mac carries no quarantine flag, so no
// notarization is involved. Without swiftc the island falls back to the JXA helper.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type BuildResult =
  | { ok: true; path: string; built: boolean; ms: number }
  | { ok: false; reason: 'no-swiftc' | 'compile-failed' | 'not-macos'; detail?: string }

export type BuildDeps = {
  /** Runs a command; resolves with exit code and stderr. Tests stub it. */
  run?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number; stderr: string }>
  cacheRoot?: string
  platform?: string
}

const defaultRun = (cmd: string, args: string[], timeoutMs: number) =>
  new Promise<{ code: number; stderr: string }>((res) =>
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) =>
      res({ code: !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1, stderr: String(stderr ?? '') })
    )
  )

export function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

export function cacheDir(root = join(homedir(), 'Library', 'Caches', 'orca-island')): string {
  return root
}

/**
 * Returns the cached binary for this exact source, building it when missing. Builds into a temp
 * name and renames, so a half-written binary is never run; old builds are pruned.
 */
export async function ensureHelper(pluginDir: string, deps: BuildDeps = {}, progress: (msg: string) => void = () => {}): Promise<BuildResult> {
  if ((deps.platform ?? process.platform) !== 'darwin') return { ok: false, reason: 'not-macos' }
  const run = deps.run ?? defaultRun
  const src = join(pluginDir, 'helper', 'island.swift')
  const hash = sourceHash(readFileSync(src, 'utf8'))
  const root = cacheDir(deps.cacheRoot)
  const dir = join(root, hash)
  const bin = join(dir, 'island-helper')
  if (existsSync(bin) && statSync(bin).size > 0) return { ok: true, path: bin, built: false, ms: 0 }
  const which = await run('/usr/bin/xcrun', ['--find', 'swiftc'], 15_000)
  if (which.code !== 0) return { ok: false, reason: 'no-swiftc', detail: which.stderr.trim().slice(0, 200) }
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `island-helper.${process.pid}.tmp`)
  progress('正在编译 Island 程序（首次约 1 分钟）…')
  const t0 = Date.now()
  const r = await run('/usr/bin/xcrun', ['swiftc', '-O', '-o', tmp, src], 10 * 60_000)
  if (r.code !== 0 || !existsSync(tmp)) {
    rmSync(tmp, { force: true })
    return { ok: false, reason: 'compile-failed', detail: r.stderr.split('\n').filter((l) => l.includes('error')).slice(0, 3).join(' | ').slice(0, 400) }
  }
  renameSync(tmp, bin)
  // Keep only this build; earlier source versions are no longer needed.
  try {
    for (const d of readdirSync(root)) if (d !== hash) rmSync(join(root, d), { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  return { ok: true, path: bin, built: true, ms: Date.now() - t0 }
}
