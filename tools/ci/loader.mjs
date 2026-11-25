// Resolves `orca/testing` to the CI stand-in and extensionless relative imports to .ts files.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const shim = new URL('./orca-testing.mjs', import.meta.url).href
export async function resolve(spec, ctx, next) {
  if (spec === 'orca/testing') return { url: shim, shortCircuit: true }
  if ((spec.startsWith('./') || spec.startsWith('../')) && !/\.[cm]?[jt]s$/.test(spec) && ctx.parentURL) {
    const url = new URL(spec + '.ts', ctx.parentURL)
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
  }
  return next(spec, ctx)
}
