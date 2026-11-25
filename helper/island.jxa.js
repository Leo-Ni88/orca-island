// Orca Island helper, JXA fallback (used when the Xcode Command Line Tools are missing). Run: osascript -l JavaScript helper/island.jxa.js
// Same JSON Lines protocol as island.swift (subset: hello/upsert/remove/ping/quit -> ready/pong/clicked/error).
ObjC.import('Cocoa')
ObjC.import('stdlib')

const env = $.NSProcessInfo.processInfo.environment
const allowCapture = !env.objectForKey('ISLAND_ALLOW_CAPTURE').isNil()

function out(obj) {
  obj.v = 1
  const s = $(JSON.stringify(obj) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(s)
}
function log(s) {
  $.NSFileHandle.fileHandleWithStandardError.writeData($('[island-jxa] ' + s + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
}

const items = {}
let orcaBundleId = 'com.stablyai.orca'
let panels = []
const rank = { blocked: 0, failed: 1, done: 2, waiting: 3, working: 4 }

function top() {
  const all = Object.values(items)
  all.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || b.t - a.t)
  return all[0]
}

function activateOrca() {
  const ws = $.NSWorkspace.sharedWorkspace
  const url = ws.URLForApplicationWithBundleIdentifier(orcaBundleId)
  if (url.isNil()) { log('no app for ' + orcaBundleId); return }
  const cfg = $.NSWorkspaceOpenConfiguration.configuration
  cfg.activates = true
  ws.openApplicationAtURLConfigurationCompletionHandler(url, cfg, null)
}

ObjC.registerSubclass({
  name: 'IslandTarget',
  methods: {
    'clicked:': { types: ['void', ['id']], implementation: function (_sender) {
      const t = top(); if (!t) return
      activateOrca()
      out({ type: 'clicked', id: t.id, action: 'focus' })
    } },
    // NB: data.length is a bridged NSUInteger; compare via Number(), strict === 0 never matches.
    'stdinData:': { types: ['void', ['id']], implementation: function (note) {
      const data = note.userInfo.objectForKey($.NSFileHandleNotificationDataItem)
      if (Number(data.length) === 0) { log('stdin EOF, exiting'); $.NSApplication.sharedApplication.terminate(null); $.exit(0); return }
      const chunk = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding))
      buffer += chunk
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
        if (line.trim()) { try { handle(line) } catch (e) { log('handle error: ' + e); out({ type: 'error', code: 'exception', message: String(e) }) } }
      }
      $.NSFileHandle.fileHandleWithStandardInput.readInBackgroundAndNotify
    } },
    'rebuild:': { types: ['void', ['id']], implementation: function (_n) { rebuild() } },
  },
})
let buffer = ''
const target = $.IslandTarget.alloc.init

function rebuild() {
  panels.forEach(p => p.panel.orderOut(null))
  panels = []
  const screens = $.NSScreen.screens
  for (let i = 0; i < screens.count; i++) {
    const s = screens.objectAtIndex(i)
    const f = s.frame
    const notchH = s.safeAreaInsets.top
    let rect
    if (notchH > 0) {
      const l = s.auxiliaryTopLeftArea, r = s.auxiliaryTopRightArea
      const nw = f.size.width - l.size.width - r.size.width
      rect = $.NSMakeRect(f.origin.x + l.size.width - 120, f.origin.y + f.size.height - notchH, nw + 240, notchH)
    } else {
      const vf = s.visibleFrame
      const menuH = Math.max(f.origin.y + f.size.height - (vf.origin.y + vf.size.height), 24)
      rect = $.NSMakeRect(f.origin.x + f.size.width / 2 - 130, f.origin.y + f.size.height - menuH + 1, 260, menuH - 2)
    }
    // NSWindowStyleMaskBorderless=0 | NSWindowStyleMaskNonactivatingPanel=1<<7
    const p = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(rect, 1 << 7, $.NSBackingStoreBuffered, false)
    p.floatingPanel = true
    p.level = $.NSMainMenuWindowLevel + 3
    // canJoinAllSpaces(1) | stationary(16) | ignoresCycle(64) | fullScreenAuxiliary(256)
    p.collectionBehavior = 1 | 16 | 64 | 256
    p.backgroundColor = $.NSColor.clearColor
    p.opaque = false
    p.hasShadow = false
    p.hidesOnDeactivate = false
    p.becomesKeyOnlyIfNeeded = true
    if (!allowCapture) p.sharingType = 0 // NSWindowSharingNone
    // NB: never touch .CGColor from JXA: CGColorRef is not bridged and osascript dies with SIGKILL.
    const frame = $.NSMakeRect(0, 0, rect.size.width, rect.size.height)
    const box = $.NSBox.alloc.initWithFrame(frame)
    box.boxType = 4 // NSBoxCustom
    box.titlePosition = 0 // NSNoTitle
    box.fillColor = $.NSColor.blackColor
    box.borderWidth = 1.5
    box.cornerRadius = rect.size.height / 2
    box.contentViewMargins = $.NSMakeSize(0, 0)
    const b = $.NSButton.alloc.initWithFrame(frame)
    b.bordered = false
    b.target = target
    b.action = 'clicked:'
    const root = $.NSView.alloc.initWithFrame(frame)
    root.addSubview(box)
    const label = $.NSTextField.labelWithString($(''))
    label.frame = $.NSMakeRect(12, (rect.size.height - 16) / 2, rect.size.width - 24, 16)
    label.textColor = $.NSColor.whiteColor
    label.font = $.NSFont.boldSystemFontOfSize(12)
    root.addSubview(label)
    root.addSubview(b)
    p.contentView = root
    panels.push({ panel: p, button: b, box, label })
  }
  render()
}

function render() {
  const t = top()
  if (!t) { panels.forEach(p => p.panel.orderOut(null)); return }
  const sym = { blocked: '!', failed: '✗', done: '✓', waiting: '…', working: '◌' }[t.state] || '•'
  const color = t.state === 'blocked' ? $.NSColor.systemOrangeColor : t.state === 'done' ? $.NSColor.systemGreenColor
    : t.state === 'failed' ? $.NSColor.systemRedColor : $.NSColor.darkGrayColor
  const n = Object.keys(items).length
  panels.forEach(({ panel, button, box, label }) => {
    label.stringValue = $(sym + ' ' + n + '   ' + t.title)
    button.title = $('')
    box.borderColor = color
    panel.orderFrontRegardless
  })
}

function handle(line) {
  let m
  try { m = JSON.parse(line) } catch (e) { out({ type: 'error', code: 'bad_json', message: line }); return }
  switch (m.type) {
    case 'hello': if (m.orca && m.orca.bundleId) orcaBundleId = m.orca.bundleId; break
    case 'upsert': if (m.item && m.item.id) { items[m.item.id] = { id: m.item.id, title: m.item.title || m.item.id, state: m.item.state === 'needs_you' ? 'blocked' : (m.item.state || 'working'), t: Date.now() }; render() } break
    case 'remove': delete items[m.id]; render(); break
    case 'ping': out({ type: 'pong', seq: m.seq }); break
    // The JXA fallback draws only the collapsed pill; it plays sounds but does not
    // expand cards, has no hotkey and no menu-bar mode (see docs/architecture.md).
    case 'peek': if (m.sound) { const snd = $.NSSound.soundNamed(m.sound); if (!snd.isNil()) snd.play } break
    case 'summary': case 'config': case 'clear_unread': case 'groups': case 'detail': case 'answered': case 'hint': case 'toast': case 'picked': break
    case 'reset': for (const k of Object.keys(items)) delete items[k]; render(); break
    case 'debug_click': target.clicked(null); break
    case 'quit': $.NSApplication.sharedApplication.terminate(null); break
    default: out({ type: 'error', code: 'unknown_type', message: String(m.type) })
  }
}

const app = $.NSApplication.sharedApplication
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
rebuild()
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(target, 'stdinData:', $.NSFileHandleReadCompletionNotification, $.NSFileHandle.fileHandleWithStandardInput)
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(target, 'rebuild:', $.NSApplicationDidChangeScreenParametersNotification, null)
$.NSFileHandle.fileHandleWithStandardInput.readInBackgroundAndNotify

const scr = []
for (let i = 0; i < $.NSScreen.screens.count; i++) {
  const s = $.NSScreen.screens.objectAtIndex(i)
  scr.push({ hasNotch: s.safeAreaInsets.top > 0, w: s.frame.size.width, h: s.frame.size.height })
}
out({ type: 'ready', version: '1.0.0', impl: 'jxa', pid: $.NSProcessInfo.processInfo.processIdentifier, screens: scr })
app.run
