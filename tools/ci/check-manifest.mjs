// Manifest checks for CI, where the Orca CLI (`orca plugin validate`) is not available.
// They cover what most often breaks; `orca plugin validate .` stays the real check before a release.
import { readFileSync, statSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = new URL('../..', import.meta.url).pathname
const m = JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8'))
const errors = []
const need = (ok, msg) => ok || errors.push(msg)

need(m.manifestVersion === 2, 'manifestVersion must be 2')
need(/^[a-z0-9][a-z0-9-]*$/.test(m.id) && !m.id.startsWith('orca-'), 'id: lowercase kebab-case, not starting with orca-')
need(/^\d+\.\d+\.\d+$/.test(m.version), 'version must be X.Y.Z')
need(m.license === 'MIT' && existsSync(join(root, 'LICENSE')), 'license MIT with a LICENSE file')
need(m.execution === 'trusted-worker' && existsSync(join(root, m.main)), 'main must exist')
need(Array.isArray(m.capabilities) && m.capabilities.every((c) => typeof c.kind === 'string'), 'capabilities are { kind } objects')
for (const s of m.contributes?.statusBarItems ?? []) need(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.id), `status bar id ${s.id} must be kebab-case`)

const png = (p) => {
  const b = readFileSync(join(root, p))
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), size: statSync(join(root, p)).size }
}
if (m.icon) {
  const i = png(m.icon)
  need(i.w === i.h && i.w >= 128 && i.size <= 256 * 1024, `icon ${i.w}x${i.h} ${i.size} B: square, >= 128, <= 256 KB`)
}
if (m.cover) {
  const c = png(m.cover.path)
  need(c.w * 10 === c.h * 16 && c.size <= 1024 * 1024, `cover ${c.w}x${c.h}: 16:10, <= 1 MB`)
}
const shots = m.screenshots ?? []
need(shots.length <= 6, 'at most 6 screenshots')
let total = 0
for (const s of shots) {
  const i = png(s.path)
  total += i.size
  need(i.w >= 1280 && i.h >= 800, `${s.path}: at least 1280x800`)
}
need(total <= 8 * 1024 * 1024, 'screenshots at most 8 MB in total')

// The directory refuses executables, native modules, archives, bytecode and symlinks. Check what
// git would ship (the tracked files), by their bytes: only UTF-8 text, PNG, GIF and WEBP may go.
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean)
const isText = (b) => {
  if (b.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b)
    return true
  } catch {
    return false
  }
}
const isImage = (b) =>
  (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') ||
  b.toString('latin1', 0, 4) === 'GIF8' ||
  (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP')
for (const f of tracked) {
  const p = join(root, f)
  const st = lstatSync(p)
  need(!st.isSymbolicLink(), `symlink: ${f}`)
  need(!(st.mode & 0o111), `executable bit: ${f}`)
  need(!/(^|\/)__pycache__\//.test(f) && !/\.(pyc|pyo|class|o|so|a|jar|wasm|zip|tar|gz|tgz|dylib|node|exe|app)$/.test(f), `bytecode, native or archive: ${f}`)
  if (!st.isSymbolicLink()) {
    const b = readFileSync(p)
    need(isText(b) || isImage(b), `not text, PNG, GIF or WEBP: ${f}`)
  }
}

if (errors.length) {
  console.error(errors.map((e) => `✖ ${e}`).join('\n'))
  process.exit(1)
}
console.log('manifest ok')
