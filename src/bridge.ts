// IslandBridge: spawns the native helper from the plugin folder and talks JSON Lines over stdio.
// Protocol: docs/architecture.md. Spawn, hello/ready handshake (5s), upsert/remove replay after restart, ping/pong,
// 1s..60s backoff restart, breaker (>3 crashes/60s) and singleton refusal (exit 3) -> L3. Kept free of Orca APIs so it unit-tests in plain Node.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type HelperKind = 'swift' | 'jxa'
export type HelperMsg = { v?: number; type: string; [k: string]: unknown }

export type BridgeOptions = {
  pluginDir: string
  kind: HelperKind
  bundleId: string
  onMessage: (msg: HelperMsg) => void
  log: (line: string) => void
  /** Sent in `hello` (and replayed on restart). */
  config?: () => Record<string, unknown>
  /** ready | down (crashed, restarting) | tripped (breaker open or another helper owns the island). */
  onStatus?: (status: 'ready' | 'down' | 'tripped', detail?: string) => void
  /** The compiled Swift helper (from the per-user cache); defaults to helper/bin/island-helper. */
  binary?: string
  /** Extra environment for the helper (tests use ISLAND_LOCK_PATH). */
  env?: Record<string, string>
  /** Overrides for tests. */
  spawnFn?: typeof spawn
  readyTimeoutMs?: number
}

export function helperCommand(pluginDir: string, kind: HelperKind, binary?: string): { cmd: string; args: string[] } {
  if (kind === 'jxa') return { cmd: '/usr/bin/osascript', args: ['-l', 'JavaScript', join(pluginDir, 'helper', 'island.jxa.js')] }
  return { cmd: binary ?? join(pluginDir, 'helper', 'bin', 'island-helper'), args: [] }
}

export class IslandBridge {
  private child: ChildProcess | undefined
  private buf = ''
  private crashes: number[] = []
  private backoffMs = 1000
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private readyTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  ready: HelperMsg | undefined
  tripped = false
  lastError: string | undefined
  /** Replayed after every (re)start: last upsert per id. */
  private items = new Map<string, HelperMsg>()

  constructor(private o: BridgeOptions) {}

  get pid(): number | undefined {
    return this.child?.pid
  }

  start(): void {
    this.stopped = false
    const { cmd, args } = helperCommand(this.o.pluginDir, this.o.kind, this.o.binary)
    if (this.o.kind === 'swift') {
      if (!existsSync(cmd)) {
        this.lastError = `helper binary missing: ${cmd}`
        this.o.log(this.lastError)
        return
      }
      // Installs from zip/git may drop the exec bit (see docs/architecture.md); restore it.
      try {
        if ((statSync(cmd).mode & 0o111) === 0) chmodSync(cmd, 0o755)
      } catch (e) {
        this.o.log(`chmod failed: ${String(e)}`)
      }
    }
    const sp = this.o.spawnFn ?? spawn
    let child: ChildProcess
    try {
      child = sp(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: false, env: { ...process.env, ...(this.o.env ?? {}) } })
    } catch (e) {
      this.lastError = `spawn threw: ${String(e)}`
      this.o.log(this.lastError)
      this.scheduleRestart()
      return
    }
    this.child = child
    this.buf = ''
    this.ready = undefined
    child.on('error', (e) => {
      this.lastError = `spawn error: ${String(e)}`
      this.o.log(this.lastError)
    })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.o.log(`helper stderr: ${chunk.trimEnd()}`))
    child.stdin?.on('error', (e) => this.o.log(`helper stdin error: ${String(e)}`))
    child.on('exit', (code, signal) => {
      this.o.log(`helper exited code=${code} signal=${signal}`)
      if (this.child === child) this.child = undefined
      this.ready = undefined
      clearTimeout(this.readyTimer)
      if (this.stopped) return
      if (code === 3) {
        // Singleton lock held by another helper (another Orca, or a duplicate load): do not fight it.
        this.tripped = true
        this.lastError = 'already_running'
        this.o.onStatus?.('tripped', 'already_running')
        return
      }
      this.onCrash()
    })
    this.readyTimer = setTimeout(() => {
      if (!this.ready) {
        this.lastError = 'no ready within timeout'
        this.o.log(this.lastError)
        child.kill()
      }
    }, this.o.readyTimeoutMs ?? 5000)
    this.send({ type: 'hello', orca: { bundleId: this.o.bundleId, pid: process.ppid }, config: this.o.config?.() ?? {} })
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let msg: HelperMsg
      try {
        msg = JSON.parse(line) as HelperMsg
      } catch {
        this.o.log(`helper sent non-JSON: ${line}`)
        continue
      }
      if (msg.type === 'ready') {
        this.ready = msg
        this.backoffMs = 1000
        clearTimeout(this.readyTimer)
        for (const m of this.items.values()) this.send(m)
        this.o.onStatus?.('ready')
      }
      this.o.onMessage(msg)
    }
  }

  private onCrash(): void {
    const now = Date.now()
    this.crashes = this.crashes.filter((t) => now - t < 60_000)
    this.crashes.push(now)
    if (this.crashes.length > 3) {
      this.tripped = true
      this.lastError = 'breaker: >3 crashes in 60s'
      this.o.log('helper crashed >3 times in 60s: breaker tripped (fall back to L3)')
      this.o.onStatus?.('tripped', 'breaker')
      return
    }
    this.o.onStatus?.('down')
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    clearTimeout(this.restartTimer)
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000)
    this.restartTimer = setTimeout(() => this.start(), delay)
  }

  send(msg: HelperMsg): boolean {
    if (msg.type === 'upsert') {
      const item = msg.item as { id: string }
      this.items.set(item.id, msg)
    } else if (msg.type === 'remove') {
      this.items.delete(msg.id as string)
    }
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) return false
    stdin.write(JSON.stringify({ v: 1, ...msg }) + '\n')
    return true
  }

  get isReady(): boolean {
    return !!this.ready && !!this.child
  }

  /** Forget replayed items (e.g. after the worker resets its store). */
  resetItems(): void {
    this.items.clear()
  }

  /** Closing stdin is the exit signal (helper exits on EOF). */
  stop(): void {
    this.stopped = true
    clearTimeout(this.restartTimer)
    clearTimeout(this.readyTimer)
    const c = this.child
    this.child = undefined
    if (c) {
      c.stdin?.end()
      setTimeout(() => {
        if (c.exitCode === null && c.signalCode === null) c.kill()
      }, 2000).unref?.()
    }
  }
}
