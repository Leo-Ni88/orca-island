// Where a jump goes, by source, using supported plugin methods and the bot deep link only.
import { chatIdOf } from './directory'
import type { Item } from './state'

export type Target = (
  | { kind: 'terminal'; label: string }
  | { kind: 'bot'; url: string; label: string }
  | { kind: 'workspace'; workspaceId: string; label: string }
  | { kind: 'orca'; label: string }
) & {
  /** Orca cannot open one chat tab: name the tab the person should switch to. */
  tab?: string
}

/** `exact` only for a terminal pane; Orca has no supported way to open one chat or item. */
export function jumpTarget(i: Item): Target {
  if (i.kind === 'bot_item' && i.openUrl) return { kind: 'bot', url: i.openUrl, label: '去 Orca 回答', tab: i.tab }
  if (i.kind && i.kind !== 'session') return { kind: 'orca', label: '打开 Orca' }
  const chat = !!chatIdOf(i.paneKey)
  if (chat && i.botChat && i.openUrl) return { kind: 'bot', url: i.openUrl, label: `打开 ${i.bot ?? 'bot'}`, tab: i.tab }
  if (chat) return i.workspaceListId ? { kind: 'workspace', workspaceId: i.workspaceListId, label: `打开 ${i.workspace ?? '工作区'}`, tab: i.tab } : { kind: 'orca', label: '打开 Orca' }
  if (i.terminalId || i.workspaceListId) return { kind: 'terminal', label: '跳转到会话' }
  return { kind: 'orca', label: '打开 Orca' }
}

export type JumpHost = {
  focus(terminalId: string): Promise<{ focused: boolean }>
  agents(workspaceId: string): Promise<{ terminalId: string | null; sessionId?: string | null }[]>
  terminals(workspaceId: string): Promise<{ id: string }[]>
  openWorkspace(workspaceId: string): Promise<unknown>
  openUrl(url: string): void
  /** Remember what was learnt about the session's terminal. */
  setTerminal(terminalId: string | null): void
}
export type JumpResult = { target: Target['kind']; exact: boolean; terminalId?: string; tried: string[]; tab?: string }

export async function jump(i: Item, h: JumpHost): Promise<JumpResult> {
  const t = jumpTarget(i)
  const tried: string[] = []
  if (t.kind === 'bot') return h.openUrl(t.url), { target: 'bot', exact: false, tried, tab: t.tab }
  if (t.kind === 'orca') return { target: 'orca', exact: false, tried }
  if (t.kind === 'terminal') {
    const seen = new Set<string>()
    const tryFocus = async (id: string | null | undefined, how: string): Promise<boolean> => {
      if (!id || seen.has(id)) return false
      seen.add(id)
      try {
        const ok = (await h.focus(id)).focused
        tried.push(`${how}:${ok ? 'ok' : 'not focused'}`)
        return ok
      } catch (e) {
        tried.push(`${how}:${String((e as Error)?.message ?? e).slice(0, 60)}`)
        return false
      }
    }
    if (await tryFocus(i.terminalId, 'cached')) return { target: 'terminal', exact: true, terminalId: i.terminalId!, tried }
    const ws = i.workspaceListId
    if (ws) {
      const list = i.sessionId ? await h.agents(ws).catch(() => []) : []
      const found = list.find((a) => a.sessionId === i.sessionId)?.terminalId
      if (await tryFocus(found, 'agents.list')) return h.setTerminal(found!), { target: 'terminal', exact: true, terminalId: found!, tried }
      // The terminal list has no session ids: only a workspace's single terminal is no guess.
      const terms = await h.terminals(ws).catch(() => [])
      if (terms.length === 1 && (await tryFocus(terms[0].id, 'only terminal'))) return { target: 'terminal', exact: false, terminalId: terms[0].id, tried }
      if (i.terminalId && terms.length && !terms.some((x) => x.id === i.terminalId)) h.setTerminal(null)
    }
  }
  const ws = t.kind === 'workspace' ? t.workspaceId : i.workspaceListId
  if (ws) {
    try {
      await h.openWorkspace(ws)
      tried.push('workspace.open:ok')
      return { target: 'workspace', exact: false, tried, tab: t.tab }
    } catch (e) {
      tried.push(`workspace.open:${String((e as Error)?.message ?? e).slice(0, 60)}`)
    }
  }
  return { target: 'orca', exact: false, tried }
}
