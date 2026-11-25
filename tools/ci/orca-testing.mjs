// A stand-in for `orca/testing` so the pure tests run in CI without the Orca app.
// Tests that mount the worker need Orca's test host (`orca plugin test`); here they are skipped.
import * as nt from 'node:test'
import assert from 'node:assert/strict'

const NEEDS_ORCA = Symbol('needs-orca')
const needsOrca = () => {
  const e = new Error('needs the Orca test host (run `orca plugin test .`)')
  e[NEEDS_ORCA] = true
  throw e
}
const wrap = (fn) => async (t, ...rest) => {
  try {
    return await fn(t, ...rest)
  } catch (e) {
    if (e?.[NEEDS_ORCA]) return t.skip(e.message)
    throw e
  }
}
export function test(name, opts, fn) {
  if (typeof opts === 'function') return nt.test(name, wrap(opts))
  return nt.test(name, opts, fn && wrap(fn))
}
export const describe = nt.describe
export const afterEach = nt.afterEach
export const beforeEach = nt.beforeEach
export const before = nt.before
export const after = nt.after
export { assert }
export const mockHost = () => ({})
export const mountWorker = needsOrca
export const hostError = (code, message = code) => Object.assign(new Error(message), { code, retryable: false })
