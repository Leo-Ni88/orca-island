// One item per peek. A burst shows at most `max` one after another, then a single "+N".
export type PeekOut = {
  show(p: { id?: string; more?: number; text?: string; ttlMs: number; sound?: string } & Record<string, unknown>): void
  /** Why an item was not shown now (list open, locked, dropped by the +N cap, answered meanwhile). */
  skipped?(ids: string[], reason: string): void
}
type T = { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }

export class PeekQueue {
  private q: { id: string; ttlMs: number; p0: boolean }[] = []
  private timer: unknown
  private shown = 0
  /** The list is open: the person is looking at everything already. */
  private paused = false
  private locked = false
  /** Arrived while the screen was locked: announced together on unlock. */
  private away = new Set<string>()
  private summarised: string[] = []
  private current: string | undefined

  constructor(
    private t: T,
    private out: PeekOut,
    /** Still worth showing (not answered or read meanwhile). */
    private valid: (id: string) => boolean,
    private max = 3,
    private gapMs = 350
  ) {}

  add(ids: string[], ttlMs: number, p0: (id: string) => boolean, sound?: string): void {
    if (this.locked) {
      for (const id of ids) this.away.add(id)
      this.out.skipped?.(ids, 'locked: held for the summary')
      return
    }
    if (this.paused) {
      this.out.skipped?.(ids, 'list open')
      if (sound) this.out.show({ ttlMs: 0, sound })
      return
    }
    for (const id of ids) {
      this.q = this.q.filter((x) => x.id !== id)
      const e = { id, ttlMs, p0: p0(id) }
      const at = e.p0 ? this.q.findIndex((x) => !x.p0) : -1
      at < 0 ? this.q.push(e) : this.q.splice(at, 0, e)
    }
    if (this.timer === undefined) this.next(sound)
    else if (sound) this.out.show({ ttlMs: 0, sound })
  }

  setListOpen(open: boolean): void {
    this.paused = open
    if (open) this.clear()
  }

  /** The helper saw the lock before we did, and did not show it. */
  held(id: string): void {
    for (const x of id ? [id] : this.summarised) this.away.add(x)
    this.setLocked(true)
  }

  setLocked(locked: boolean, summary?: (ids: string[]) => ({ text: string; ttlMs: number; sound?: string } & Record<string, unknown>) | undefined): void {
    if (locked === this.locked) return
    this.locked = locked
    if (locked) {
      // Nobody is there to see the one on screen or those waiting.
      for (const x of this.q) this.away.add(x.id)
      if (this.current) this.away.add(this.current)
      this.clear()
      return
    }
    const ids = [...this.away].filter((id) => this.valid(id))
    this.away.clear()
    this.summarised = ids
    // The summary decides what is news (it may also count rows that never queued a peek).
    const s = summary?.(ids)
    if (!s || this.paused) return
    this.out.show(s)
    this.timer = this.t.set(() => {
      this.timer = undefined
      this.next()
    }, s.ttlMs + this.gapMs)
  }

  /** The person dismissed or clicked the current peek. */
  skip(): void {
    if (this.timer === undefined) return
    this.t.clear(this.timer)
    this.timer = undefined
    this.next()
  }

  clear(): void {
    if (this.timer !== undefined) this.t.clear(this.timer)
    this.timer = undefined
    this.q = []
    this.shown = 0
    this.current = undefined
  }

  private next(sound?: string): void {
    const gone = this.q.filter((x) => !this.valid(x.id)).map((x) => x.id)
    if (gone.length) this.out.skipped?.(gone, 'answered or read before its turn')
    this.q = this.q.filter((x) => this.valid(x.id))
    if (!this.q.length) {
      this.timer = undefined
      this.shown = 0
      this.current = undefined
      if (sound) this.out.show({ ttlMs: 0, sound })
      return
    }
    let ttl: number
    if (this.shown >= this.max) {
      ttl = 4000
      this.current = undefined
      this.out.skipped?.(this.q.map((x) => x.id), 'burst cap: counted in +N')
      this.out.show({ more: this.q.length, ttlMs: ttl, sound })
      this.q = []
    } else {
      const e = this.q.shift()!
      ttl = e.ttlMs
      this.current = e.id
      this.shown++
      this.out.show({ id: e.id, ttlMs: ttl, sound })
    }
    this.timer = this.t.set(() => {
      this.timer = undefined
      this.next()
    }, ttl + this.gapMs)
  }
}
