import { assert, test } from 'orca/testing'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureHelper, sourceHash } from './helper-build'

function plugin(src = 'print("hi")') {
  const d = mkdtempSync(join(tmpdir(), 'island-build-'))
  mkdirSync(join(d, 'helper'))
  writeFileSync(join(d, 'helper', 'island.swift'), src)
  return d
}

test('builds once per source version, into the cache, and reuses it', async () => {
  const p = plugin()
  const cache = mkdtempSync(join(tmpdir(), 'island-cache-'))
  const calls: string[] = []
  const run = async (_c: string, a: string[]) => {
    calls.push(a.join(' '))
    if (a[0] === 'swiftc') writeFileSync(a[a.indexOf('-o') + 1], 'bin')
    return { code: 0, stderr: '' }
  }
  const r1 = await ensureHelper(p, { run, cacheRoot: cache, platform: 'darwin' })
  assert.ok(r1.ok && r1.built && r1.path.includes(sourceHash('print("hi")')))
  const r2 = await ensureHelper(p, { run, cacheRoot: cache, platform: 'darwin' })
  assert.ok(r2.ok && !r2.built)
  assert.equal(calls.filter((c) => c.startsWith('swiftc')).length, 1)
  writeFileSync(join(p, 'helper', 'island.swift'), 'print("v2")')
  const r3 = await ensureHelper(p, { run, cacheRoot: cache, platform: 'darwin' })
  assert.ok(r3.ok && r3.built)
  assert.equal(readdirSync(cache).length, 1, 'older builds are pruned')
  rmSync(p, { recursive: true }); rmSync(cache, { recursive: true })
})

test('no swiftc, failed compile, other platforms: no binary, nothing half-written', async () => {
  const p = plugin()
  const cache = mkdtempSync(join(tmpdir(), 'island-cache-'))
  const none = await ensureHelper(p, { run: async () => ({ code: 1, stderr: 'xcrun: error: unable to find utility "swiftc"' }), cacheRoot: cache, platform: 'darwin' })
  assert.deepEqual([none.ok, !none.ok && none.reason], [false, 'no-swiftc'])
  const bad = await ensureHelper(p, { run: async (_c, a) => ({ code: a[0] === 'swiftc' ? 1 : 0, stderr: 'x.swift:1: error: nope' }), cacheRoot: cache, platform: 'darwin' })
  assert.deepEqual([bad.ok, !bad.ok && bad.reason], [false, 'compile-failed'])
  assert.ok(!readdirSync(cache).some((d) => readdirSync(join(cache, d)).length), 'no binary left behind')
  assert.equal((await ensureHelper(p, { cacheRoot: cache, platform: 'linux' })).ok, false)
  rmSync(p, { recursive: true }); rmSync(cache, { recursive: true })
})

test('real compile of the shipped helper (macOS with the Command Line Tools)', { skip: process.platform !== 'darwin' || !existsSync('/Library/Developer/CommandLineTools/usr/bin/swiftc') && !existsSync('/Applications/Xcode.app') } as never, async () => {
  const cache = mkdtempSync(join(tmpdir(), 'island-cache-'))
  const r = await ensureHelper(resolve(import.meta.dirname, '..'), { cacheRoot: cache })
  assert.ok(r.ok && r.built && existsSync(r.path), JSON.stringify(r))
  rmSync(cache, { recursive: true })
})
