// Orca Island helper. Single file, SwiftUI in one fixed transparent panel per screen; no dependencies.
// Motion: the window never animates. One shape morphs pill -> peek -> list -> detail.
// Build: swiftc -O -o helper/bin/island-helper helper/island.swift   (arm64 linker ad-hoc signs it)
// Protocol: JSON Lines over stdio, v:1 (docs/architecture.md). stdout = protocol only; logs -> stderr.
// The helper only draws and reports input; all state and policy live in the worker.
// Exits on stdin EOF (worker gone / plugin disabled).
import AppKit
import SwiftUI
import Carbon.HIToolbox

let VERSION = "1.0.2"
let env = ProcessInfo.processInfo.environment

func log(_ s: String) { FileHandle.standardError.write(("[island] " + s + "\n").data(using: .utf8)!) }

func emit(_ obj: [String: Any]) {
    var o = obj; o["v"] = 1
    guard let d = try? JSONSerialization.data(withJSONObject: o), let line = String(data: d, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

// MARK: - Singleton

var lockFd: Int32 = -1
/// One helper per user session (dev + release Orca, or a plugin reloaded twice, must not show two islands).
/// Waits up to ~3s so a restarting worker's old helper has time to see EOF and exit.
func acquireSingleton() -> (ok: Bool, holder: String) {
    let path = env["ISLAND_LOCK_PATH"] ?? (NSTemporaryDirectory() as NSString).appendingPathComponent("orca-island-helper.lock")
    lockFd = open(path, O_CREAT | O_RDWR, 0o644)
    if lockFd < 0 { return (true, "") } // cannot lock: do not block the island over it
    for _ in 0..<30 {
        if flock(lockFd, LOCK_EX | LOCK_NB) == 0 {
            ftruncate(lockFd, 0)
            let s = "\(getpid())\n"
            _ = s.withCString { write(lockFd, $0, strlen($0)) }
            return (true, "")
        }
        usleep(100_000)
    }
    let holder = (try? String(contentsOfFile: path, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "?"
    return (false, holder)
}

// MARK: - Model

struct Item: Equatable, Identifiable {
    var id: String
    var title: String
    var workspace: String?
    var branch: String?
    var agent: String?
    var state: String // needs_you | failed | done | interrupted | working
    var priority: Int
    var startedAt: Double
    var stateSince: Double
    var unread: Bool
    var sub: String
    var group: String
    var detail: String?
    var options: [String]
    var reply: Bool
    var line: String
    var jump: String
    var isNew: Bool
    /// terminal | bot | orca: what kind of row, shown as a small glyph.
    var source = ""
}

struct IslandSection: Equatable { var name: String?; var ids: [String] }
struct IslandGroup: Equatable { var key: String; var name: String; var counts: [String: Int]; var collapsed: Bool; var sections: [IslandSection] }
func parseGroup(_ d: [String: Any]) -> IslandGroup? {
    guard let key = d["key"] as? String, let name = d["name"] as? String else { return nil }
    let secs = ((d["sections"] as? [[String: Any]]) ?? []).map { IslandSection(name: $0["name"] as? String, ids: ($0["ids"] as? [String]) ?? []) }
    return IslandGroup(key: key, name: name, counts: (d["counts"] as? [String: Int]) ?? [:], collapsed: (d["collapsed"] as? Bool) ?? false, sections: secs)
}
func countsText(_ c: [String: Int]) -> NSAttributedString {
    let out = NSMutableAttributedString()
    for (k, sym, st) in [("needs_you", "!", "needs_you"), ("failed", "✗", "failed"), ("done", "✓", "done"), ("working", "◌", "working")] {
        guard let n = c[k], n > 0 else { continue }
        out.append(NSAttributedString(string: "\(out.length > 0 ? "  " : "")\(sym)\(n)", attributes: [.foregroundColor: tint(st), .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold)]))
    }
    let ps = NSMutableParagraphStyle(); ps.alignment = .right
    out.addAttribute(.paragraphStyle, value: ps, range: NSRange(location: 0, length: out.length))
    return out
}

func parseItem(_ d: [String: Any]) -> Item? {
    guard let id = d["id"] as? String else { return nil }
    let now = Date().timeIntervalSince1970 * 1000
    return Item(id: id, title: (d["title"] as? String) ?? "Agent", workspace: d["workspace"] as? String,
                branch: d["branch"] as? String, agent: d["agent"] as? String,
                state: (d["state"] as? String) ?? "working", priority: (d["priority"] as? Int) ?? 4,
                startedAt: (d["startedAt"] as? Double) ?? now, stateSince: (d["stateSince"] as? Double) ?? now,
                unread: (d["unread"] as? Bool) ?? false,
                sub: (d["sub"] as? String) ?? "", group: (d["group"] as? String) ?? "", detail: d["detail"] as? String,
                options: (d["options"] as? [String]) ?? [], reply: (d["reply"] as? Bool) ?? false,
                line: (d["line"] as? String) ?? "", jump: (d["jump"] as? String) ?? "打开 Orca", isNew: (d["isNew"] as? Bool) ?? false,
                source: (d["source"] as? String) ?? "")
}

let ORDER: [String: Int] = ["needs_you": 0, "failed": 1, "done": 2, "interrupted": 3, "working": 4]
func sorted(_ items: [Item]) -> [Item] {
    items.sorted { a, b in
        let ra = ORDER[a.state] ?? 9, rb = ORDER[b.state] ?? 9
        if ra != rb { return ra < rb }
        if a.unread != b.unread { return a.unread }
        return a.stateSince < b.stateSince
    }
}

/// Demo rendering pins the clock so durations do not tick between frames.
var demoNow: Double? = nil
func ago(_ ms: Double) -> String {
    let s = max(0, Int(((demoNow ?? Date().timeIntervalSince1970 * 1000) - ms) / 1000))
    if s < 60 { return "\(s)s" }
    if s < 3600 { return "\(s / 60)m" }
    return "\(s / 3600)h\((s % 3600) / 60)m"
}

let SYMBOL = ["needs_you": "!", "failed": "✗", "done": "✓", "interrupted": "⊘", "working": "◌"]
func tint(_ state: String) -> NSColor {
    switch state {
    case "needs_you": return .systemOrange
    case "failed": return .systemRed
    case "done": return .systemGreen
    case "interrupted": return .systemGray
    default: return NSColor(white: 0.55, alpha: 1)
    }
}
func label(_ state: String) -> String {
    ["needs_you": "需要你", "failed": "失败", "done": "完成", "interrupted": "已中断", "working": "运行中"][state] ?? state
}

// MARK: - Row models and text measurement (built off the main thread)

struct RowVM: Equatable { var id, state, title, sub, detail, status, jump: String; var source = ""; var isNew, unread: Bool; var height: CGFloat }
struct CountVM: Equatable, Identifiable { var id, symbol: String; var n: Int }
struct LineVM: Equatable, Identifiable {
    enum Kind: Equatable { case group(String, String, Bool, [CountVM]), section(String), row(RowVM) }
    var id: String, height: CGFloat, kind: Kind
}
struct DetailLayout: Equatable { var title: CGFloat = 18, question: CGFloat = 0, options: [CGFloat] = [], asks: [[CGFloat]] = [], askTitles: [CGFloat] = [], input: CGFloat = 0, note: CGFloat = 0, total: CGFloat = 90 }

/// Serial background worker: models from snapshots, text heights cached by string, font and width.
final class Builder {
    private let q = DispatchQueue(label: "island.build", qos: .userInteractive)
    private var heights: [String: CGFloat] = [:]

    func lines(items: [String: Item], groups: [IslandGroup], done: @escaping ([LineVM]) -> Void) {
        q.async { let l = Builder.lines(items, groups); DispatchQueue.main.async { done(l) } }
    }
    func layout(_ d: Detail, done: @escaping (DetailLayout) -> Void) {
        q.async { let l = self.measure(d); DispatchQueue.main.async { done(l) } }
    }
    private static func row(_ it: Item) -> LineVM {
        let detail = it.state == "working" ? "" : (it.detail ?? "")
        let h: CGFloat = 12 + 18 + (it.sub.isEmpty ? 0 : 16) + (detail.isEmpty ? 0 : 16) + 4
        return LineVM(id: "r:" + it.id, height: h, kind: .row(RowVM(id: it.id, state: it.state, title: it.reply ? "\(it.title) 回复了" : it.title, sub: it.sub, detail: detail,
            status: "\(label(it.state)) \(ago(it.state == "working" ? it.startedAt : it.stateSince))", jump: it.jump, source: it.source, isNew: it.isNew, unread: it.unread, height: h)))
    }
    private static func lines(_ items: [String: Item], _ groups: [IslandGroup]) -> [LineVM] {
        var out: [LineVM] = [], known = Set<String>()
        for g in groups {
            // Counted from the rows still here: a row removed locally (×, 清空已完成) must not leave
            // a header with old counts, or an empty one, until the worker's next groups arrive.
            let live = g.sections.flatMap { $0.ids }.compactMap { items[$0] }
            g.sections.forEach { $0.ids.forEach { known.insert($0) } }
            if live.isEmpty { continue }
            let tally = Dictionary(grouping: live, by: { FINISHED.contains($0.state) && $0.state != "failed" ? "done" : $0.state }).mapValues { $0.count }
            let counts = [("needs_you", "!"), ("failed", "✗"), ("done", "✓"), ("working", "◌")].compactMap { k, s in (tally[k] ?? 0) > 0 ? CountVM(id: k, symbol: s, n: tally[k]!) : nil }
            out.append(LineVM(id: "g:" + g.key, height: 24, kind: .group(g.name, g.key, g.collapsed, counts)))
            for s in g.sections {
                let rows = s.ids.compactMap { items[$0] }
                if g.collapsed || rows.isEmpty { continue }
                if let n = s.name { out.append(LineVM(id: "s:\(g.key)/\(n)", height: 18, kind: .section(n))) }
                out += rows.map(row)
            }
        }
        return out + sorted(Array(items.values)).filter { !known.contains($0.id) }.map(row)
    }
    private func height(_ s: String, _ size: CGFloat, _ weight: NSFont.Weight, _ width: CGFloat) -> CGFloat {
        let key = "\(size)|\(weight.rawValue)|\(width)|\(s)"
        if let h = heights[key] { return h }
        let r = (s as NSString).boundingRect(with: NSSize(width: width, height: 4000), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: NSFont.systemFont(ofSize: size, weight: weight)])
        if heights.count > 300 { heights.removeAll() }
        heights[key] = ceil(r.height)
        return ceil(r.height)
    }
    private func measure(_ d: Detail) -> DetailLayout {
        var l = DetailLayout()
        l.title = min(38, max(18, height(d.title, 13, .semibold, 340) + 1))
        l.question = d.question.isEmpty ? 0 : min(190, height(d.question, 12, .regular, 412) + 4)
        l.askTitles = d.asks.enumerated().map { (i, a) in min(52, height(d.asks.count > 1 ? "\(i + 1). \(a.question)" : a.question, 12, .semibold, 400) + 3) }
        l.asks = d.asks.map { $0.options.map { o in min(48, height(o.label + (o.recommended ? "  推荐" : ""), 12, .medium, 370) + 13) } }
        l.options = d.options.map { min(62, height(d.answerable ? "\($0.n). \($0.label)" : $0.label, 12, .medium, 392) + 13) }
        // Explained, never silently missing: Orca-only questions and the switched-off case show a greyed input.
        l.input = d.answerable && d.textOption != nil ? 62 : (d.inputKind == "orca" || d.inputKind == "off") ? 58 : 0
        l.note = d.answerable || !d.note.isEmpty || !d.asks.isEmpty ? 16 : 0
        let askParts = zip(l.askTitles, l.asks).flatMap { [$0] + $1 }
        let parts = [l.title + 16, l.question] + askParts + l.options + [l.input, l.note, 30]
        l.total = parts.filter { $0 > 0 }.reduce(0, +) + CGFloat(parts.filter { $0 > 0 }.count - 1) * 8 + 14
        return l
    }
}

// MARK: - Model (main thread only)

enum Mode: Equatable { case hidden, pill, peek, list, detail, settings }

struct Detail: Equatable {
    var id = "", title = "", source = "", question = "", note = "", primary = "", signature = ""
    var options: [(n: Int, label: String)] = []
    var textOption: Int?
    var answerable = false
    /// orca: answerable only in Orca; off: the island switch is off; none: nothing to answer.
    var inputKind = "none"
    /// One block per question, with its own options.
    var asks: [(question: String, options: [(label: String, recommended: Bool)])] = []
    static func == (a: Detail, b: Detail) -> Bool { a.id == b.id && a.question == b.question && a.signature == b.signature && a.inputKind == b.inputKind && a.asks.map { $0.question + $0.options.map { $0.label }.joined() } == b.asks.map { $0.question + $0.options.map { $0.label }.joined() } && a.note == b.note && a.primary == b.primary && a.answerable == b.answerable }
}

final class Model: ObservableObject {
    @Published var mode: Mode = .hidden
    @Published var contentMode: Mode = .hidden
    @Published var items: [String: Item] = [:]
    @Published var groups: [IslandGroup] = []
    @Published var groupMode = "project"
    @Published var peek: Item?
    @Published var peekMore = 0
    /// The "while off / away" summary: a title line, one line per kind, and the rows it is about.
    @Published var sumTitle = ""
    @Published var sumLines: [String] = []
    var sumIds: [String] = []
    @Published var detail = Detail()
    @Published var status = ""
    @Published var sending = false
    @Published var draft = ""
    @Published var selected = 0
    @Published var now = Date()
    @Published var bump = false
    /// Pointer over this screen's island (-1: none). Hover never expands; only a click does.
    @Published var hoverScreen = -1
    @Published var allowAnswer = false
    @Published var hideFromCapture = true
    @Published var answerGranted = false
    /// Waiting for the second click that turns answering on.
    @Published var confirmAnswer = false
    let rowHover = RowHover()
    @Published var activeScreen: Int = -1
    var reduceMotion = false
    @Published var lines: [LineVM] = []
    @Published var listH: CGFloat = 0
    @Published var lay = DetailLayout()
    @Published var peekText = ""
    /// Unlock summary nobody saw: a small mark on the pill until the list is opened.
    @Published var awayBadge = ""
    /// After a jump that cannot open the exact tab: which tab to switch to (shown on the pill for a few seconds).
    @Published var hint = ""
    /// Short confirmation at the bottom of the list ("已移除" + 撤销).
    @Published var toast = ""
    @Published var toastUndo = false
    /// The ⏻ menu in the list header is open.
    @Published var powerMenu = false
    var finished: Int { items.values.filter { FINISHED.contains($0.state) }.count }
    var list: [Item] { sorted(Array(items.values)) }
    var top: Item? { list.first }
    /// Rows in the order the open list draws them.
    var rowIds: [String] { lines.compactMap { if case .row(let r) = $0.kind { return r.id } else { return nil } } }
    var selectedId: String? { mode == .list ? rowIds[safe: selected] : nil }
}

let FINISHED: Set<String> = ["done", "failed", "interrupted"]
/// A bare count spelled out, for tooltips: "8 个问题在等你".
func countNoun(_ state: String, _ n: Int) -> String {
    switch state {
    case "needs_you": return "\(n) 个问题在等你"
    case "failed": return "\(n) 个任务失败"
    case "done", "interrupted": return "\(n) 个任务完成"
    case "working": return "\(n) 个任务运行中"
    default: return "\(n)"
    }
}

/// Demo recording only (off-screen): every animation and the steps between them run this many
/// times slower, so frames drawn at a slower pace land exactly where they belong. Always 1 on screen.
var SLOW: Double = 1
/// A delay inside an animation sequence, scaled with SLOW.
func motionDelay(_ s: Double) -> DispatchTime { .now() + s * SLOW }

enum Motion {
    static func spring(_ response: Double, _ damping: Double) -> Animation { .spring(response: response * SLOW, dampingFraction: damping) }
    static var hover: Animation { spring(0.22, 0.72) }
    static var expand: Animation { spring(0.42, 0.8) }
    static var collapse: Animation { spring(0.45, 1.0) }
    static var peekIn: Animation { spring(0.36, 0.78) }
    static var peekOut: Animation { spring(0.36, 1.0) }
    static var contentIn: Animation { .easeOut(duration: 0.2 * SLOW).delay(0.08 * SLOW) }
    static var contentOut: Animation { .easeIn(duration: 0.1 * SLOW) }
    static func ease(_ d: Double) -> Animation { .easeOut(duration: d * SLOW) }
    static func easeInOut(_ d: Double) -> Animation { .easeInOut(duration: d * SLOW) }
}

// MARK: - Shape

struct IslandShape: Shape {
    var width: CGFloat, height: CGFloat, radius: CGFloat
    var squareTop: Bool
    var animatableData: AnimatablePair<CGFloat, AnimatablePair<CGFloat, CGFloat>> {
        get { AnimatablePair(width, AnimatablePair(height, radius)) }
        set { width = newValue.first; height = newValue.second.first; radius = newValue.second.second }
    }
    func path(in r: CGRect) -> Path {
        let w = max(0, width), h = max(0, height), rad = min(max(0, radius), min(w, h) / 2)
        return Path(roundedRect: CGRect(x: r.midX - w / 2, y: 0, width: w, height: h),
                    cornerRadii: squareTop ? RectangleCornerRadii(bottomLeading: rad, bottomTrailing: rad)
                                           : RectangleCornerRadii(topLeading: rad, bottomLeading: rad, bottomTrailing: rad, topTrailing: rad), style: .continuous)
    }
}

struct Geo: Equatable {
    var barH: CGFloat, notchW: CGFloat, maxH: CGFloat, canvasW: CGFloat
    var notch: Bool { notchW > 0 }
    static let openW: CGFloat = 440
    var openWidth: CGFloat { max(Geo.openW, notchW + 220) }
    /// List height without the screen cap applied to the bar and chrome.
    func listHeight(_ model: Model) -> CGFloat { min(maxH, max(barH + 108, barH + 68 + model.listH)) }
    func size(_ m: Mode, _ model: Model) -> CGSize {
        switch m {
        case .hidden: return CGSize(width: notch ? notchW : 80, height: 0)
        // A jump hint ("请在右侧切到「主页」") takes the whole pill, wide enough to read in full.
        case .pill: return CGSize(width: (notch ? notchW + 220 : 320) + (model.hint.isEmpty ? 0 : hintExtra(model.hint)), height: barH)
        case .peek:
            let extra = model.peek == nil && !model.sumTitle.isEmpty ? CGFloat(max(0, model.sumLines.count + 1 - 2)) * 16 + 8 : 0
            return CGSize(width: max(model.sumTitle.isEmpty ? 400 : 460, notchW + 220), height: (notch ? barH : 4) + 58 + extra)
        case .list: return CGSize(width: openWidth, height: listHeight(model))
        case .settings: return CGSize(width: openWidth, height: min(maxH, barH + 270))
        case .detail: return CGSize(width: openWidth, height: min(maxH, barH + model.lay.total))
        }
    }
    func hintExtra(_ h: String) -> CGFloat {
        let w = (h as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold)]).width
        return max(0, min(w + 60 - (notch ? 220 : 320), openWidth - (notch ? notchW + 220 : 320)))
    }
    func radius(_ m: Mode) -> CGFloat { m == .pill || m == .hidden ? (notch ? 12 : barH / 2) : 22 }
}

// MARK: - Views

func stateColor(_ s: String) -> Color { Color(nsColor: tint(s)) }
extension Text { func dim(_ o: Double = 0.6) -> Text { foregroundColor(.white.opacity(o)) } }

struct IslandView: View {
    @ObservedObject var m: Model
    let geo: Geo
    let screen: Int
    let act: (String, [String: Any]) -> Void
    @Namespace private var ns

    /// Only the screen the person clicked opens; the others stay pills.
    var mode: Mode { (m.mode == .list || m.mode == .detail || m.mode == .settings) && m.activeScreen >= 0 && m.activeScreen != screen ? .pill : m.mode }
    var content: Mode { mode == m.mode ? m.contentMode : .pill }

    var body: some View {
        let hovered = m.hoverScreen == screen && (mode == .pill || mode == .peek)
        let grow = hovered && !m.reduceMotion
        let base = geo.size(mode, m)
        let size = CGSize(width: base.width + (grow ? 6 : 0), height: base.height + (grow ? 2 : 0))
        let r = geo.radius(mode) + (grow && mode == .pill ? 1 : 0)
        ZStack(alignment: .top) {
            IslandShape(width: size.width, height: size.height, radius: r, squareTop: geo.notch).fill(.black)
            IslandShape(width: size.width, height: size.height, radius: r, squareTop: geo.notch)
                .stroke(stateColor(m.peek?.state ?? m.top?.state ?? "working").opacity(hovered ? 1 : 0.9), lineWidth: hovered ? 2 : 1.5)
                .shadow(color: stateColor(m.peek?.state ?? m.top?.state ?? "working").opacity(hovered ? 0.55 : 0), radius: hovered ? 6 : 0)
                .brightness(hovered ? 0.12 : 0)
                .opacity(mode == .hidden ? 0 : 1)
            ZStack(alignment: .top) {
                switch content {
                case .pill: pill.frame(width: size.width, height: size.height).transition(fade)
                case .peek: peekView.frame(width: geo.size(.peek, m).width).transition(fade)
                default: EmptyView()
                }
                mounted(.list) { ListView(lines: m.lines, groupMode: m.groupMode, selectedId: m.selectedId, viewport: geo.listHeight(m) - geo.barH - 68, finished: m.finished, toast: m.toast, toastUndo: m.toastUndo, powerMenu: m.powerMenu, hover: m.rowHover, act: act).equatable() }
                mounted(.settings) { SettingsView(allow: m.allowAnswer, granted: m.answerGranted, confirming: m.confirmAnswer, hide: m.hideFromCapture, act: act) }
                mounted(.detail) { DetailView(d: m.detail, lay: m.lay, state: m.items[m.detail.id]?.state ?? "working", status: m.status, sending: m.sending, draft: $m.draft, act: act).equatable() }
            }
            .clipShape(IslandShape(width: size.width, height: size.height, radius: r, squareTop: geo.notch))
        }
        .frame(width: geo.canvasW, height: geo.maxH + 20, alignment: .top)
        .foregroundColor(.white)
        .environment(\.colorScheme, .dark)
    }

    var fade: AnyTransition { m.reduceMotion ? .opacity : .asymmetric(insertion: .modifier(active: Soft(on: true), identity: Soft(on: false)), removal: .opacity) }

    // ---- list and detail stay mounted: opening changes opacity and the shape, never lays rows out again
    func mounted<V: View>(_ which: Mode, @ViewBuilder _ v: () -> V) -> some View {
        let on = content == which
        return VStack(spacing: 0) { openBar; v() }
            .frame(width: geo.openWidth, height: geo.maxH, alignment: .top)
            .modifier(Soft(on: !on, plain: m.reduceMotion))
            .allowsHitTesting(on).accessibilityHidden(!on)
    }

    var openBar: some View {
        HStack {
            Text("Orca Island").font(.system(size: 11, weight: .semibold)).dim(0.6)
            Spacer()
            Text("收起").font(.system(size: 11)).dim(0.6)
        }
        .padding(.horizontal, 18).frame(height: geo.barH).contentShape(Rectangle()).onTapGesture { act("pill", ["screen": screen]) }
    }

    func icon(_ s: String, _ id: String, size: CGFloat) -> some View {
        Text(SYMBOL[s] ?? "•").font(.system(size: size, weight: .bold)).foregroundColor(stateColor(s))
            .matchedGeometryEffect(id: "icon-\(id)", in: ns, properties: .position, isSource: true)
    }

    // ---- pill
    var pill: some View {
        let t = m.top
        let n = m.items.values.filter { $0.state == t?.state && (t?.state != "done" || $0.unread) }.count
        let working = m.items.values.filter { $0.state == "working" }.count
        return HStack(spacing: 6) {
            if !m.hint.isEmpty {
                // Right after a jump that could not pick Orca's tab: nothing else, so it is read in full.
                Image(systemName: "arrow.up.right.square").font(.system(size: 12, weight: .semibold)).foregroundColor(.orange)
                Spacer(minLength: 0)
                Text(m.hint).font(.system(size: 12, weight: .semibold)).foregroundColor(.orange).lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: geo.notch ? geo.notchW : 0)
            } else if let t = t {
                icon(t.state, t.id, size: 12)
                Text("\(n)").font(.system(size: 12, weight: .bold)).monospacedDigit().foregroundColor(stateColor(t.state))
                    .contentTransition(.numericText(value: Double(n))).scaleEffect(m.bump ? 1.45 : 1).help(countNoun(t.state, n))
                Spacer(minLength: geo.notchW)
                if !geo.notch {
                    Text(t.title).font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                        .matchedGeometryEffect(id: "title-\(t.id)", in: ns, properties: .position, isSource: true)
                    if !t.group.isEmpty && !t.title.hasPrefix(t.group) { Text(t.group).font(.system(size: 10)).dim().lineLimit(1).fixedSize() }
                }
                Text(t.state == "working" ? ago(t.startedAt) : t.state == "needs_you" ? "等待 \(ago(t.stateSince))" : ago(t.stateSince))
                    .font(.system(size: 11, weight: .medium)).monospacedDigit().foregroundColor(.white.opacity(0.85)).fixedSize()
                if working > 0 && t.state != "working" { Text("◌\(working)").font(.system(size: 11)).monospacedDigit().dim().fixedSize().help(countNoun("working", working)) }
                if !m.awayBadge.isEmpty { Text(m.awayBadge).font(.system(size: 9, weight: .bold)).padding(.horizontal, 5).padding(.vertical, 1).background(Capsule().fill(Color.orange)).help(m.awayBadge).fixedSize() }
            }
        }
        .padding(.horizontal, 14).contentShape(Rectangle()).onTapGesture { act("pill", ["screen": screen]) }
    }

    // ---- peek: one item, one line
    var peekView: some View {
        HStack(spacing: 10) {
            if let p = m.peek {
                icon(p.state, p.id, size: 18).frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(p.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                            .matchedGeometryEffect(id: "title-\(p.id)", in: ns, properties: .position, isSource: true)
                        if !p.group.isEmpty && !p.title.hasPrefix(p.group) { Text(p.group).font(.system(size: 10)).dim().lineLimit(1).fixedSize() }
                    }
                    Text(p.line).font(.system(size: 12)).dim(0.85).lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("↗").font(.system(size: 12, weight: .semibold)).dim()
            } else {
                if !m.sumTitle.isEmpty && m.peekText.isEmpty == false && !m.sumLines.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m.sumTitle).font(.system(size: 11, weight: .semibold)).dim(0.65).lineLimit(1)
                        ForEach(Array(m.sumLines.enumerated()), id: \.offset) { k, l in
                            Text(l).font(.system(size: k == 0 ? 12.5 : 11.5, weight: k == 0 ? .semibold : .regular)).foregroundColor(.white.opacity(l.hasPrefix("另有") ? 0.55 : 0.95)).lineLimit(1).truncationMode(.tail)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Text("查看").font(.system(size: 11, weight: .semibold)).foregroundColor(.orange)
                } else {
                    Text(m.peekText.isEmpty ? "另有 \(m.peekMore) 条新消息" : m.peekText).font(.system(size: 13, weight: .semibold)).frame(maxWidth: .infinity)
                }
            }
        }
        .padding(.horizontal, 18).frame(height: geo.size(.peek, m).height - (geo.notch ? geo.barH : 4) - 4).padding(.top, geo.notch ? geo.barH : 4).contentShape(Rectangle())
        .onTapGesture { if let p = m.peek { act("jump", ["id": p.id]) } else if !m.sumIds.isEmpty { act("open_new", ["screen": screen]) } else { act("pill", ["screen": screen]) } }
    }
}

// MARK: - Open views (equatable: a mode or pill change does not touch them)

struct RowView: View, Equatable {
    let r: RowVM, selected: Bool
    @ObservedObject var hover: RowHover
    let act: (String, [String: Any]) -> Void
    static func == (a: RowView, b: RowView) -> Bool { a.r == b.r && a.selected == b.selected }
    var on: Bool { hover.id == r.id }
    var body: some View {
        HStack(spacing: 8) {
            Text(SYMBOL[r.state] ?? "•").font(.system(size: 14, weight: .bold)).foregroundColor(stateColor(r.state)).frame(width: 18)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 5) {
                    if r.isNew { Text("新").font(.system(size: 9, weight: .bold)).padding(.horizontal, 4).background(Capsule().fill(Color.orange)) }
                    if let g = ["terminal": "terminal", "bot": "person.crop.circle", "orca": "square.stack.3d.up"][r.source] {
                        Image(systemName: g).font(.system(size: 10, weight: .semibold)).foregroundColor(.white.opacity(0.55))
                            .help(["terminal": "终端会话", "bot": "Bot", "orca": "Orca"][r.source] ?? "")
                    }
                    Text(r.title).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
                }.frame(height: 18)
                if !r.sub.isEmpty { Text(r.sub).font(.system(size: 11)).dim().lineLimit(1).frame(height: 16) }
                if !r.detail.isEmpty { Text(r.detail).font(.system(size: 11)).dim(0.9).lineLimit(1).frame(height: 16) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            Text(r.status).font(.system(size: 11, weight: .medium)).monospacedDigit().foregroundColor(stateColor(r.state)).fixedSize()
            Text("↗").font(.system(size: 12, weight: .bold)).dim(0.8).frame(width: 22, height: 26).contentShape(Rectangle())
                .opacity(on || selected ? 1 : 0).help(r.jump).onTapGesture { act("jump", ["id": r.id]) }
            if r.state != "working" {
                Text("×").font(.system(size: 14)).dim(0.5).frame(width: 16, height: 26).contentShape(Rectangle()).onTapGesture { act("dismiss", ["id": r.id]) }
                    .help(r.state == "needs_you" ? "隐藏 30 分钟" : "移除")
            }
        }
        .padding(.horizontal, 8).frame(height: r.height - 4)
        .background(RoundedRectangle(cornerRadius: 9).fill(.white.opacity((r.unread ? 0.11 : 0.05) + (on ? 0.07 : 0))))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(.white.opacity(selected ? 0.45 : 0), lineWidth: 1))
        .animation(Motion.ease(0.12), value: on)
        .contentShape(Rectangle()).onTapGesture { act("open", ["id": r.id]) }
        .onHover { inside in if inside { hover.id = r.id } else if hover.id == r.id { hover.id = nil } }
        .frame(height: r.height, alignment: .top)
    }
}

/// The list header's icon buttons (⏻ and ⚙): one style, so they cannot drift apart.
struct HeaderIcon: View {
    let symbol: String, help: String
    var on = false
    let action: () -> Void
    /// SF Symbols differ in weight: the power glyph reads heavier, so it is drawn half a point smaller.
    static let trim: [String: CGFloat] = ["power": 0.5]
    var body: some View {
        Image(systemName: symbol).font(.system(size: 12 - (HeaderIcon.trim[symbol] ?? 0), weight: .medium)).imageScale(.medium)
            .foregroundColor(.white.opacity(on ? 1 : 0.75))
            .frame(width: 26, height: 22).background(RoundedRectangle(cornerRadius: 6).fill(.white.opacity(on ? 0.18 : 0)))
            .contentShape(Rectangle()).help(help).onTapGesture(perform: action)
    }
}

/// Row hover lives outside the row models, so moving the pointer never rebuilds the list.
final class RowHover: ObservableObject { @Published var id: String? }

struct ListView: View, Equatable {
    let lines: [LineVM], groupMode: String, selectedId: String?, viewport: CGFloat
    let finished: Int, toast: String, toastUndo: Bool, powerMenu: Bool
    let hover: RowHover
    let act: (String, [String: Any]) -> Void
    static func == (a: ListView, b: ListView) -> Bool { a.lines == b.lines && a.groupMode == b.groupMode && a.selectedId == b.selectedId && a.viewport == b.viewport && a.finished == b.finished && a.toast == b.toast && a.toastUndo == b.toastUndo && a.powerMenu == b.powerMenu }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach([("项目", "project"), ("Bot", "bot")], id: \.1) { name, k in
                    Text(name).font(.system(size: 11, weight: groupMode == k ? .semibold : .regular)).frame(width: 58, height: 22)
                        .background(RoundedRectangle(cornerRadius: 6).fill(.white.opacity(groupMode == k ? 0.22 : 0.06)))
                        .contentShape(Rectangle()).onTapGesture { act("set_mode", ["mode": k]) }
                }
                Spacer()
                HeaderIcon(symbol: "power", help: "关闭 Island", on: powerMenu) { act("power_menu", [:]) }
                HeaderIcon(symbol: "gearshape", help: "设置") { act("settings", [:]) }
            }.padding(.horizontal, 14).frame(height: 28, alignment: .top)
            if powerMenu {
                HStack(spacing: 6) {
                    Text("关闭 Island").font(.system(size: 11)).dim(0.6)
                    Spacer()
                    ForEach([("关 1 小时", "hour"), ("关到明早 8 点", "morning"), ("一直关", "forever")], id: \.1) { t, c in
                        Text(t).font(.system(size: 11, weight: .medium)).padding(.horizontal, 9).frame(height: 24)
                            .background(RoundedRectangle(cornerRadius: 6).fill(.white.opacity(0.12)))
                            .contentShape(Rectangle()).onTapGesture { act("power_off", ["choice": c]) }
                    }
                }.padding(.horizontal, 14).frame(height: 32).transition(.opacity)
            }
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) { ForEach(lines) { line($0) } }.padding(.horizontal, 8)
                }
                .frame(height: viewport)
                .onChange(of: selectedId) { id in if let id = id { proxy.scrollTo("r:" + id) } }
            }
            ZStack {
                HStack(spacing: 0) {
                    ForEach([("全部已读", "mark_all_read"), ("清空已完成 (\(finished))", "clear_finished"), ("暂停 30 分钟", "snooze"), ("打开 Orca", "open_orca")], id: \.1) { t, a in
                        let off = a == "clear_finished" && finished == 0
                        Text(t).font(.system(size: 11, weight: .medium)).dim(off ? 0.3 : 0.75).lineLimit(1).frame(maxWidth: .infinity, minHeight: 28)
                            .contentShape(Rectangle()).onTapGesture { if !off { act(a, [:]) } }
                    }
                }.opacity(toast.isEmpty ? 1 : 0)
                if !toast.isEmpty {
                    HStack(spacing: 12) {
                        Text(toast).font(.system(size: 11, weight: .medium)).dim(0.9).lineLimit(1)
                        if toastUndo {
                            Text("撤销").font(.system(size: 11, weight: .semibold)).foregroundColor(.orange).padding(.horizontal, 10).frame(height: 24)
                                .background(RoundedRectangle(cornerRadius: 6).fill(.white.opacity(0.1)))
                                .contentShape(Rectangle()).onTapGesture { act("undo", [:]) }
                        }
                    }.transition(.opacity)
                }
            }.frame(height: 40)
        }
    }
    @ViewBuilder func line(_ l: LineVM) -> some View {
        switch l.kind {
        case .row(let r): RowView(r: r, selected: selectedId == r.id, hover: hover, act: act).equatable()
            .transition(.asymmetric(insertion: .opacity, removal: .opacity.combined(with: .offset(x: 24))))
        case .section(let n): Text(n).font(.system(size: 10.5)).dim(0.5).lineLimit(1).padding(.leading, 16).frame(height: l.height, alignment: .center).transition(.opacity)
        case .group(let name, let key, let collapsed, let counts):
            HStack {
                Text(collapsed ? "▸" : "▾").font(.system(size: 10)).dim(0.8)
                Text(name).font(.system(size: 11.5, weight: .bold)).dim(0.85).lineLimit(1)
                Spacer()
                ForEach(counts) { c in
                    Text("\(c.symbol)\(c.n)").font(.system(size: 11, weight: .semibold)).monospacedDigit().foregroundColor(stateColor(c.id)).contentTransition(.numericText(value: Double(c.n))).help(countNoun(c.id, c.n))
                }
            }.padding(.horizontal, 6).frame(height: l.height).contentShape(Rectangle())
                .onTapGesture { act("toggle_group", ["key": key, "collapsed": !collapsed]) }.transition(.opacity)
        }
    }
}

struct SettingsView: View {
    let allow: Bool, granted: Bool, confirming: Bool, hide: Bool
    let act: (String, [String: Any]) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("‹").font(.system(size: 20, weight: .semibold)).frame(width: 24, height: 24).contentShape(Rectangle()).onTapGesture { act("back", [:]) }
                Text("设置").font(.system(size: 13, weight: .semibold))
                Spacer()
            }
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("允许在 Island 中直接回答").font(.system(size: 12.5, weight: .semibold))
                    Text(granted ? "在 Island 里回答终端中 Claude Code 的提示。关闭时不读取、不输入任何终端。" : "需要先在 Orca 里授予终端读写权限。")
                        .font(.system(size: 11)).dim(0.65).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Capsule().fill(allow ? Color.orange : Color.white.opacity(0.2)).frame(width: 36, height: 20)
                    .overlay(Circle().fill(.white).frame(width: 16, height: 16).offset(x: allow ? 8 : -8))
                    .opacity(granted ? 1 : 0.4).contentShape(Rectangle())
                    .onTapGesture { if granted { act("toggle_answer", [:]) } }
            }
            if confirming {
                VStack(alignment: .leading, spacing: 8) {
                    Text("开启后，Island 可以向你的终端输入").font(.system(size: 12, weight: .semibold)).foregroundColor(.orange)
                    HStack(spacing: 8) {
                        Text("确认开启").font(.system(size: 12, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 28)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(0.9))).contentShape(Rectangle())
                            .onTapGesture { act("confirm_answer", [:]) }
                        Text("取消").font(.system(size: 12)).frame(maxWidth: .infinity, minHeight: 28)
                            .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.1))).contentShape(Rectangle())
                            .onTapGesture { act("cancel_answer", [:]) }
                    }
                }.padding(10).background(RoundedRectangle(cornerRadius: 10).fill(Color.orange.opacity(0.12)))
            }
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("截图和录屏时隐藏 Island").font(.system(size: 12.5, weight: .semibold))
                    Text("共享屏幕时别人看不到；关闭后你自己才能截图").font(.system(size: 11)).dim(0.65).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Capsule().fill(hide ? Color.orange : Color.white.opacity(0.2)).frame(width: 36, height: 20)
                    .overlay(Circle().fill(.white).frame(width: 16, height: 16).offset(x: hide ? 8 : -8)).contentShape(Rectangle())
                    .onTapGesture { act("toggle_capture", [:]) }
            }
            Spacer(minLength: 0)
            Text("其他设置：Orca 设置 → 插件 → Orca Island → ⋯ → 详情").font(.system(size: 10.5)).dim(0.5)
        }.padding(.horizontal, 14).padding(.bottom, 12)
    }
}

struct DetailView: View, Equatable {
    let d: Detail, lay: DetailLayout, state: String, status: String, sending: Bool, draft: Binding<String>
    let act: (String, [String: Any]) -> Void
    static func == (a: DetailView, b: DetailView) -> Bool {
        a.d == b.d && a.lay == b.lay && a.state == b.state && a.status == b.status && a.sending == b.sending && a.draft.wrappedValue == b.draft.wrappedValue
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("‹").font(.system(size: 20, weight: .semibold)).frame(width: 24, height: 24).contentShape(Rectangle()).onTapGesture { act("back", [:]) }
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 6) {
                        Text(SYMBOL[state] ?? "•").font(.system(size: 13, weight: .bold)).foregroundColor(stateColor(state))
                        Text(d.title).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                    }.frame(height: lay.title)
                    Text(d.source).font(.system(size: 11)).dim().lineLimit(1).frame(height: 16)
                }
                Spacer(minLength: 0)
            }.frame(height: lay.title + 16)
            if lay.question > 0 {
                ScrollView(.vertical, showsIndicators: false) {
                    Text(d.question).font(.system(size: 12)).dim(0.95).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(height: lay.question)
            }
            ForEach(Array(d.asks.enumerated()), id: \.offset) { qi, a in
                Text("\(d.asks.count > 1 ? "\(qi + 1). " : "")\(a.question)").font(.system(size: 12, weight: .semibold)).frame(maxWidth: .infinity, alignment: .leading).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    .frame(height: lay.askTitles[safe: qi] ?? 18)
                ForEach(Array(a.options.enumerated()), id: \.offset) { oi, o in
                    HStack(spacing: 6) {
                        Text(o.label).font(.system(size: 12, weight: .medium)).lineLimit(2)
                        if o.recommended { Text("推荐").font(.system(size: 9.5, weight: .bold)).padding(.horizontal, 5).padding(.vertical, 1).background(Capsule().fill(Color.orange.opacity(0.85))) }
                        Spacer(minLength: 4)
                        Text("去 Orca 选 ↗").font(.system(size: 10.5)).dim(0.55)
                    }
                    .padding(.horizontal, 10).frame(height: lay.asks[safe: qi]?[safe: oi] ?? 30)
                    .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.09)))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.white.opacity(0.14), lineWidth: 1))
                    .padding(.leading, 12).contentShape(Rectangle())
                    .onTapGesture { act("pick", ["id": d.id, "label": o.label]) }
                }
            }
            ForEach(Array(d.options.enumerated()), id: \.offset) { i, o in
                Text(d.answerable ? "\(o.n). \(o.label)" : o.label).font(.system(size: 12, weight: .medium)).lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 10).frame(height: lay.options[safe: i] ?? 30)
                    .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(d.answerable ? 0.16 : 0.05)))
                    .opacity(d.answerable ? (sending ? 0.5 : 1) : 0.7).contentShape(Rectangle())
                    .onTapGesture { if d.answerable && !sending { act("answer", ["id": d.id, "option": o.n, "signature": d.signature]) } }
            }
            if lay.input > 0, !d.answerable {
                VStack(alignment: .leading, spacing: 4) {
                    Text("输入其他想法").font(.system(size: 12)).dim(0.3).padding(.horizontal, 8).padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading).background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.05)))
                    if d.inputKind == "off" {
                        HStack(spacing: 2) {
                            Text("在 ⚙ 里打开「允许在 Island 中直接回答」后可直接回答，开启后显示选项").font(.system(size: 11)).dim(0.65)
                            Text("打开 ⚙").font(.system(size: 11, weight: .semibold)).foregroundColor(.orange).underline().contentShape(Rectangle())
                                .onTapGesture { act("settings", [:]) }
                        }.lineLimit(1).minimumScaleFactor(0.85)
                    } else {
                        Text("这类问题只能在 Orca 里回答").font(.system(size: 11)).dim(0.65)
                    }
                }.frame(height: lay.input, alignment: .top)
            }
            if lay.input > 0, d.answerable, let n = d.textOption {
                HStack(alignment: .bottom, spacing: 6) {
                    TextField("输入其他想法", text: draft, axis: .vertical).lineLimit(3).textFieldStyle(.plain).font(.system(size: 12))
                        .padding(8).frame(height: lay.input, alignment: .topLeading).background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.1)))
                    Text("发送").font(.system(size: 12, weight: .semibold)).padding(.horizontal, 10).padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.orange.opacity(draft.wrappedValue.isEmpty || sending ? 0.3 : 0.9)))
                        .onTapGesture { if !draft.wrappedValue.isEmpty && !sending { act("answer", ["id": d.id, "option": n, "signature": d.signature, "text": draft.wrappedValue]) } }
                }.frame(height: lay.input)
            }
            if lay.note > 0 { Text(status.isEmpty ? d.note : status).font(.system(size: 11)).dim(0.7).lineLimit(1).frame(height: lay.note) }
            Text(d.primary).font(.system(size: 12, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 30, maxHeight: 30)
                .background(RoundedRectangle(cornerRadius: 8).fill(d.answerable ? Color.white.opacity(0.12) : Color.orange.opacity(0.85)))
                .contentShape(Rectangle()).onTapGesture { act("jump", ["id": d.id]) }
        }.padding(.horizontal, 14).frame(height: lay.total, alignment: .top)
    }
}

struct Soft: ViewModifier {
    let on: Bool
    var plain = false
    /// Hidden views draw nothing: opacity 0 (they stay mounted, so they open without a layout pass).
    var hiddenOpacity: Double = 0
    func body(content: Content) -> some View { content.opacity(on ? hiddenOpacity : 1).scaleEffect(on && !plain ? 0.96 : 1, anchor: .top).blur(radius: on && !plain ? 4 : 0) }
}
extension Array { subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil } }

// MARK: - Panel

final class IslandPanel: NSPanel {
    /// Key only while a text field is wanted (detail with an input); the pill and peeks never take focus.
    var wantsKey = false
    override var canBecomeKey: Bool { wantsKey }
    override var canBecomeMain: Bool { false }
}

final class IslandHost: NSHostingView<IslandView> {
    var hitRect: () -> CGRect = { .zero }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    /// Everything outside the island shape is click-through.
    override func hitTest(_ p: NSPoint) -> NSView? { hitRect().contains(superview?.convert(p, to: self) ?? p) ? super.hitTest(p) : nil }
    required init(rootView: IslandView) { super.init(rootView: rootView) }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
}

final class ScreenIsland {
    private var wasInside = false
    let screen: NSScreen, index: Int, geo: Geo, panel: IslandPanel, host: IslandHost
    unowned let island: Island

    init(screen: NSScreen, index: Int, forcePill: Bool, island: Island, offscreen: Bool) {
        self.screen = screen; self.index = index; self.island = island
        let f = screen.frame, nh = screen.safeAreaInsets.top
        var notchW: CGFloat = 0, barH = max(f.maxY - screen.visibleFrame.maxY, 24) - 2, x = f.midX
        if nh > 0, !forcePill, let l = screen.auxiliaryTopLeftArea, let r = screen.auxiliaryTopRightArea {
            notchW = f.width - l.width - r.width; barH = nh; x = f.minX + l.width + notchW / 2
        }
        geo = Geo(barH: barH, notchW: notchW, maxH: (f.height * 0.6).rounded(), canvasW: max(Geo.openW, notchW + 220) + 60)
        let h = geo.maxH + 20
        panel = IslandPanel(contentRect: NSRect(x: x - geo.canvasW / 2, y: offscreen ? -20000 : f.maxY - h - (notchW > 0 ? 0 : 1), width: geo.canvasW, height: h),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.backgroundColor = .clear; panel.isOpaque = false; panel.hasShadow = false
        panel.hidesOnDeactivate = false; panel.animationBehavior = .none
        panel.ignoresMouseEvents = true // toggled by the pointer being over the island
        panel.sharingType = (island.config["hideFromCapture"] as? Bool ?? true) ? .none : .readOnly
        host = IslandHost(rootView: IslandView(m: island.model, geo: geo, screen: index, act: { [weak island] a, d in island?.act(a, d) }))
        host.frame = NSRect(x: 0, y: 0, width: geo.canvasW, height: h)
        panel.contentView = host
        host.hitRect = { [weak self] in self?.hit ?? .zero }
    }
    /// Island bounds inside the hosting view (flipped: y down). Generous while the shape settles.
    var hit: CGRect {
        let m = island.model
        let open = (m.mode == .list || m.mode == .detail || m.mode == .settings) && (m.activeScreen < 0 || m.activeScreen == index)
        let s = geo.size(open ? m.mode : m.mode == .peek ? .peek : m.mode == .hidden ? .hidden : .pill, m)
        let g: CGFloat = m.hoverScreen == index && !open ? 6 : 0
        return CGRect(x: (geo.canvasW - s.width - g) / 2, y: 0, width: s.width + g, height: s.height + g / 3)
    }
    func contains(_ p: NSPoint) -> Bool {
        let r = hit, f = panel.frame
        return NSRect(x: f.minX + r.minX, y: f.maxY - r.maxY, width: r.width, height: r.height).contains(p)
    }
    func updateMouse() {
        let m = island.model
        let inside = m.mode != .hidden && contains(NSEvent.mouseLocation)
        if panel.ignoresMouseEvents == inside { panel.ignoresMouseEvents = !inside }
        let over = inside ? index : (m.hoverScreen == index ? -1 : m.hoverScreen)
        if inside && m.mode == .peek && m.peek == nil { island.awaySeen() }
        if over != m.hoverScreen { withAnimation(m.reduceMotion ? .easeOut(duration: 0.12) : Motion.hover) { m.hoverScreen = over } }
        if inside { NSCursor.pointingHand.set() } else if over == -1 && m.hoverScreen == -1 && wasInside { NSCursor.arrow.set() }
        wasInside = inside
        if !inside && m.rowHover.id != nil && m.activeScreen == index { m.rowHover.id = nil }
    }
}

// MARK: - Controller

let OFFSCREEN = env["ISLAND_OFFSCREEN"] != nil // tests and evidence frames: nothing on screen, no focus, no hotkeys, no sound

final class Island: NSObject, NSMenuDelegate {
    let model = Model()
    var screens: [ScreenIsland] = []
    var statusItem: NSStatusItem?
    var orcaBundleId = "com.stablyai.orca"
    var config: [String: Any] = [:]
    var screenLocked = false
    private let builder = Builder()
    private var buildQueued = false, buildSeq = 0, detailSeq = 0
    private var gen = 0
    private var peekTimer: Timer?, tickTimer: Timer?
    private var monitors: [Any] = []
    private var hotKeys: [UInt32: EventHotKeyRef] = [:]
    private var handlerInstalled = false
    private var lastPresence = ""

    var displayMode: String { (config["displayMode"] as? String) ?? "auto" }
    var isOpen: Bool { model.mode == .list || model.mode == .detail || model.mode == .settings }

    func screensInfo() -> [[String: Any]] {
        NSScreen.screens.enumerated().map { (i, s) in
            ["id": (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? i,
             "hasNotch": s.safeAreaInsets.top > 0, "w": s.frame.width, "h": s.frame.height, "name": s.localizedName]
        }
    }

    func rebuild() {
        if isOpen { close() }
        model.reduceMotion = (config["reduceMotion"] as? Bool) ?? NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        screens.forEach { $0.panel.orderOut(nil) }
        screens = displayMode == "menubar" ? [] : (OFFSCREEN ? Array(NSScreen.screens.prefix(1)) : NSScreen.screens).enumerated().map {
            ScreenIsland(screen: $1, index: $0, forcePill: displayMode == "pill", island: self, offscreen: OFFSCREEN)
        }
        if displayMode == "menubar" || displayMode == "auto+menubar", !OFFSCREEN {
            if statusItem == nil {
                statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
                let m = NSMenu(); m.delegate = self; m.autoenablesItems = false
                statusItem?.menu = m
            }
        } else if let si = statusItem { NSStatusBar.system.removeStatusItem(si); statusItem = nil }
        refresh(force: true)
        prewarm()
    }

    /// Lays the detail out once while invisible and leaves it there: the first real one is then an update.
    private var warmed = false
    func prewarm() {
        guard !warmed else { return }
        warmed = true
        var d = Detail()
        d.title = "Orca Island"; d.source = "·"; d.question = "·"; d.note = "·"; d.primary = "打开 Orca"
        setDetail(d)
    }

    /// Coalesced: many stdin updates make one background build; unchanged lines publish nothing.
    func rebuildLines() {
        if buildQueued { return }
        buildQueued = true
        DispatchQueue.main.async { [self] in
            buildQueued = false
            buildSeq += 1
            let seq = buildSeq
            builder.lines(items: model.items, groups: model.groups) { [self] l in
                guard seq == buildSeq, l != model.lines else { return }
                // Animated only where it can be seen; a hidden list just takes the new rows.
                withAnimation(isOpen && !model.reduceMotion ? Motion.expand : nil) {
                    model.lines = l
                    model.listH = l.reduce(0) { $0 + $1.height }
                }
            }
        }
    }

    /// Shows `d` once its text has been measured off the main thread; a newer one wins.
    func setDetail(_ d: Detail, then: (() -> Void)? = nil) {
        detailSeq += 1
        let seq = detailSeq
        builder.layout(d) { [self] l in
            guard seq == detailSeq else { return }
            withAnimation(model.mode == .detail && !model.reduceMotion ? Motion.expand : nil) { model.detail = d; model.lay = l }
            then?()
        }
    }

    /// After any data change: show or hide the panels, keep views' identity.
    func refresh(force: Bool = false) {
        renderStatusItem()
        if model.items.isEmpty {
            if model.mode != .hidden { go(.hidden) }
            tickTimer?.invalidate(); tickTimer = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                guard let s = self, s.model.items.isEmpty else { return }
                s.screens.forEach { $0.panel.orderOut(nil) }; s.unwatch()
            }
            return
        }
        for s in screens where force || !s.panel.isVisible { s.panel.orderFrontRegardless() } // never activates
        if model.mode == .hidden { go(.pill) }
        watch()
        if tickTimer == nil { tickTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.model.now = Date(); self?.rebuildLines() } }
    }

    // ---- motion: content follows the shape in, and leaves before it shrinks
    func go(_ to: Mode) {
        gen += 1
        let g = gen, from = model.mode
        let rank: [Mode: Int] = [.hidden: 0, .pill: 1, .peek: 2, .list: 3, .detail: 3, .settings: 3]
        let grow = rank[to]! >= rank[from]!
        if model.reduceMotion {
            model.mode = to
            DispatchQueue.main.async { [weak self] in if let s = self, s.gen == g { withAnimation(Motion.easeInOut(0.15)) { s.model.contentMode = to } } }
            return
        }
        let shape = to == .peek ? Motion.peekIn : grow ? Motion.expand : from == .peek ? Motion.peekOut : Motion.collapse
        if grow {
            withAnimation(shape) { model.mode = to }
            // Its own turn: in the same one, the mounted views sometimes keep the old opacity.
            DispatchQueue.main.async { [weak self] in if let s = self, s.gen == g { withAnimation(Motion.contentIn) { s.model.contentMode = to } } }
        } else {
            withAnimation(Motion.contentOut) { model.contentMode = .hidden }
            DispatchQueue.main.asyncAfter(deadline: motionDelay(0.08)) { [weak self] in
                guard let s = self, s.gen == g else { return }
                withAnimation(shape) { s.model.mode = to }
                DispatchQueue.main.async { if s.gen == g { withAnimation(Motion.contentIn) { s.model.contentMode = to } } }
            }
        }
    }

    func open(screen: Int) {
        clearAway()
        peekTimer?.invalidate(); peekTimer = nil
        model.activeScreen = screen; model.selected = 0
        go(.list)
        emit(["type": "list", "open": true])
        navKeys(true)
    }

    func close() {
        model.powerMenu = false
        guard isOpen else { return }
        releaseKey(); navKeys(false)
        model.draft = ""; model.status = ""; model.sending = false
        let seen = model.groups.isEmpty ? Array(model.items.keys) : model.groups.filter { !$0.collapsed }.flatMap { $0.sections.flatMap { $0.ids } }
        go(model.items.isEmpty ? .hidden : .pill)
        emit(["type": "list", "open": false])
        emit(["type": "collapsed", "ids": seen, "seen": true])
        DispatchQueue.main.async { self.updateMouse() }
    }

    func back() {
        if model.mode == .settings { model.confirmAnswer = false; go(.list); navKeys(true) }
        else if model.mode == .detail { releaseKey(); model.draft = ""; model.status = ""; model.sending = false; detailSeq += 1; model.detail.id = ""; go(.list); navKeys(true) } else { close() }
    }

    func sessionLocked() -> Bool {
        if screenLocked || NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.loginwindow" { return true }
        return (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
    }
    // ---- unlock summary (F8): shown once the person is really there, kept until seen
    private var awayText = "", awayAt = Date.distantPast, awayWatch: Any?, awayTimer: Timer?
    private var awayShownAt: Date?
    /// Waits for ~2 s after unlock and the first mouse move or key, then shows it until hovered or 20 s.
    /// The structured summary that came with the text (title, lines, new rows, badge).
    var pendingSum: (String, [String], [String], String)?
    func queueAway(_ text: String) {
        awayText = text; awayAt = Date()
        let sum = pendingSum; pendingSum = nil
        model.sumTitle = sum?.0 ?? ""; model.sumLines = sum?.1 ?? []; model.sumIds = sum?.2 ?? []
        model.awayBadge = sum?.3 ?? text
        awayTimer?.invalidate(); if let w = awayWatch { NSEvent.removeMonitor(w); awayWatch = nil }
        if OFFSCREEN && config["debugAwayNow"] as? Bool == true { showAway(); return }
        awayWatch = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .keyDown, .leftMouseDown, .scrollWheel]) { [weak self] _ in self?.awayInput() }
    }
    func awayInput() {
        guard !awayText.isEmpty, !sessionLocked() else { return }
        let wait = 2 - Date().timeIntervalSince(awayAt)
        if let w = awayWatch { NSEvent.removeMonitor(w); awayWatch = nil }
        awayTimer?.invalidate()
        awayTimer = Timer.scheduledTimer(withTimeInterval: max(0, wait), repeats: false) { [weak self] _ in self?.showAway() }
    }
    func showAway() {
        guard !awayText.isEmpty, !isOpen else { return }
        model.peekText = awayText
        if model.mode == .peek { withAnimation(Motion.peekIn) { model.peek = nil; model.peekMore = 0 } } else { model.peek = nil; model.peekMore = 0; go(.peek) }
        awayShownAt = Date()
        emit(["type": "peeked", "id": "", "text": awayText, "screens": screens.filter { $0.panel.isVisible }.map { $0.screen.localizedName }])
        peekTimer?.invalidate()
        peekTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in self?.endPeek() }
    }
    /// Hovered: seen, the badge goes once the peek ends.
    func awaySeen() {
        guard awayShownAt != nil, model.peek == nil, model.mode == .peek else { return }
        awayShownAt = nil; awayText = ""; model.awayBadge = ""
        emit(["type": "away_seen"])
        peekTimer?.invalidate()
        peekTimer = Timer.scheduledTimer(withTimeInterval: 2.5 * SLOW, repeats: false) { [weak self] _ in self?.endPeek() }
    }
    func clearAway() {
        awayText = ""; awayShownAt = nil; model.awayBadge = ""; model.sumIds = []
        awayTimer?.invalidate(); if let w = awayWatch { NSEvent.removeMonitor(w); awayWatch = nil }
    }

    func showPeek(id: String?, more: Int, text: String, ttl: Double) {
        if !text.isEmpty, id == nil || id == "" { queueAway(text); return }
        // An item peek never covers the summary while it is up; it shows after.
        if model.mode == .peek, model.peek == nil, awayShownAt != nil { return }
        guard !isOpen, !model.items.isEmpty else { return }
        // Checked here too: the worker's view of the lock can be a few seconds old.
        if !OFFSCREEN || config["debugLocked"] != nil, (config["debugLocked"] as? Bool) ?? sessionLocked() {
            emit(["type": "held", "id": id ?? ""]); reportPresence(force: true); return
        }
        let it = id.flatMap { model.items[$0] }
        if it == nil && more == 0 && text.isEmpty { return }
        model.peekText = text
        if it != nil || more > 0 { model.sumTitle = ""; model.sumLines = [] }
        if model.mode == .peek { withAnimation(Motion.peekIn) { model.peek = it; model.peekMore = more } } else { model.peek = it; model.peekMore = more; go(.peek) }
        emit(["type": "peeked", "id": id ?? "", "screens": screens.filter { $0.panel.isVisible }.map { $0.screen.localizedName }])
        peekTimer?.invalidate()
        peekTimer = Timer.scheduledTimer(withTimeInterval: ttl / 1000 * SLOW, repeats: false) { [weak self] _ in self?.endPeek() }
    }
    func endPeek() {
        peekTimer?.invalidate(); peekTimer = nil
        if model.mode == .peek { go(model.items.isEmpty ? .hidden : .pill); DispatchQueue.main.asyncAfter(deadline: motionDelay(0.4)) { [weak self] in if self?.model.mode != .peek { self?.model.peek = nil } } }
    }

    /// Ids leaving in a staggered collapse; a worker `remove` for one of them is left to the stagger.
    var leaving = Set<String>()
    func staggerRemove(_ ids: [String]) {
        leaving.formUnion(ids)
        let step = model.reduceMotion ? 0 : 0.045
        let steps = min(ids.count, 8)
        for k in 0..<steps {
            // The last step takes all the rest, so a long list never takes long to clear.
            let batch = k == steps - 1 ? Array(ids[k...]) : [ids[k]]
            DispatchQueue.main.asyncAfter(deadline: motionDelay(step * Double(k))) { [weak self] in
                guard let s = self else { return }
                for id in batch where s.leaving.remove(id) != nil { s.model.items[id] = nil }
                s.rebuildNow()
                if k == steps - 1 { s.refresh() }
            }
        }
    }
    /// Like rebuildLines, but not coalesced with other changes in the same turn.
    func rebuildNow() { buildQueued = false; rebuildLines() }

    func showToast(_ text: String, undo: Bool) {
        withAnimation(Motion.contentIn) { model.toast = text; model.toastUndo = undo }
        DispatchQueue.main.asyncAfter(deadline: motionDelay(undo ? 3 : 2)) { [weak self] in
            if self?.model.toast == text { withAnimation(Motion.contentOut) { self?.model.toast = "" } }
        }
    }

    // ---- actions from the views
    func act(_ a: String, _ d: [String: Any]) {
        switch a {
        case "pill": isOpen ? close() : open(screen: (d["screen"] as? Int) ?? 0)
        case "back": back()
        case "open_new":
            // From the summary: the list, with the first new row selected (and scrolled to).
            let first = model.sumIds.first
            open(screen: (d["screen"] as? Int) ?? 0)
            if let f = first { DispatchQueue.main.async { [weak self] in if let s = self, let k = s.model.rowIds.firstIndex(of: f) { s.model.selected = k } } }
        case "power_menu": withAnimation(Motion.expand) { model.powerMenu.toggle() }
        case "power_off":
            model.powerMenu = false
            emit(["type": "clicked", "action": a, "choice": (d["choice"] as? String) ?? "forever"])
        case "clear_finished":
            // Rows leave one after another, top to bottom; the worker's removes for them are absorbed.
            let ids = model.rowIds.filter { model.items[$0].map { FINISHED.contains($0.state) } ?? false }
            emit(["type": "clicked", "action": a])
            staggerRemove(ids)
        case "undo":
            withAnimation(Motion.contentOut) { model.toast = "" }
            emit(["type": "clicked", "action": a])
        case "settings": model.confirmAnswer = false; go(.settings); navKeys(true)
        case "toggle_answer":
            if model.allowAnswer { emit(["type": "setting", "key": "allowAnswer", "value": false]) }
            else { withAnimation(Motion.expand) { model.confirmAnswer = true } }
        case "confirm_answer":
            withAnimation(Motion.expand) { model.confirmAnswer = false }
            emit(["type": "setting", "key": "allowAnswer", "value": true, "confirmed": true])
        case "toggle_capture": emit(["type": "setting", "key": "hideFromCapture", "value": !model.hideFromCapture])
        case "cancel_answer": withAnimation(Motion.expand) { model.confirmAnswer = false }
        case "open":
            guard let id = d["id"] as? String, let it = model.items[id] else { return }
            // Shown at once with what is known; the worker fills in the question and options.
            var x = Detail(); x.id = id; x.title = it.title; x.source = [it.group, it.sub].filter { !$0.isEmpty }.joined(separator: " · ")
            x.question = it.detail ?? ""; x.primary = it.jump
            model.detail.id = id; model.status = ""; model.draft = ""
            setDetail(x) { [weak self] in if let s = self, s.isOpen, s.model.detail.id == id { s.go(.detail); s.navKeys(true) } }
            emit(["type": "clicked", "action": "open", "id": id])
        case "answer":
            model.sending = true; model.status = "发送中…"
            releaseKey()
            emit(["type": "clicked", "action": "answer"].merging(d) { $1 })
        case "pick":
            activateOrca()
            model.status = "正在打开 Orca…"
            emit(["type": "clicked", "action": "pick"].merging(d) { $1 })
        case "jump":
            activateOrca()
            emit(["type": "clicked", "action": "jump"].merging(d) { $1 })
            if isOpen { close() } else { endPeek() }
        case "open_orca": activateOrca(); close()
        case "snooze": emit(["type": "clicked", "action": "snooze", "minutes": 30])
        case "set_mode":
            withAnimation(Motion.expand) { model.groupMode = (d["mode"] as? String) ?? "project" }
            emit(["type": "clicked", "action": a].merging(d) { $1 })
        default: emit(["type": "clicked", "action": a].merging(d) { $1 })
        }
    }

    // ---- focus: key only while typing, then given back
    func allowKey() { screens[safe: max(0, model.activeScreen)]?.panel.wantsKey = true; screens[safe: max(0, model.activeScreen)]?.panel.becomesKeyOnlyIfNeeded = true }
    func releaseKey() {
        for s in screens where s.panel.wantsKey {
            let was = s.panel.isKeyWindow
            s.panel.wantsKey = false
            s.panel.makeFirstResponder(nil)
            if was { s.panel.orderOut(nil); s.panel.orderFrontRegardless() } // hands key back to the app in front
        }
    }

    // ---- pointer: the canvas ignores the mouse except over the shape
    func watch() {
        guard monitors.isEmpty, !OFFSCREEN else { return }
        let move: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
        if let x = NSEvent.addGlobalMonitorForEvents(matching: move, handler: { [weak self] _ in self?.updateMouse() }) { monitors.append(x) }
        if let x = NSEvent.addLocalMonitorForEvents(matching: move, handler: { [weak self] e in self?.updateMouse(); return e }) { monitors.append(x) }
        if let x = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown], handler: { [weak self] _ in self?.clickedOutside() }) { monitors.append(x) }
        if let x = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { [weak self] e in
            // While composing (Chinese input), Esc belongs to the input method.
            if e.keyCode == UInt16(kVK_Escape), (NSApp.keyWindow?.firstResponder as? NSTextView)?.hasMarkedText() != true { self?.back(); return nil }
            return e
        }) { monitors.append(x) }
    }
    func unwatch() { monitors.forEach(NSEvent.removeMonitor); monitors.removeAll() }
    func updateMouse() { screens.forEach { $0.updateMouse() } }
    /// Only a real mouse-down outside every island closes the card (not key or app changes).
    func clickedOutside() { if isOpen, !screens.contains(where: { $0.contains(NSEvent.mouseLocation) }) { close() } }

    // ---- keys (Carbon: no Accessibility permission). Navigation keys exist only while the list is open.
    private func hotKey(_ id: UInt32, _ code: Int, _ mods: Int, _ on: Bool) {
        if let r = hotKeys.removeValue(forKey: id) { UnregisterEventHotKey(r) }
        guard on, !OFFSCREEN else { return }
        if !handlerInstalled {
            handlerInstalled = true
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, ev, _ in
                var k = EventHotKeyID()
                GetEventParameter(ev, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &k)
                let id = k.id
                DispatchQueue.main.async { island.key(id) }
                return noErr
            }, 1, &spec, nil, nil)
        }
        var ref: EventHotKeyRef?
        let st = RegisterEventHotKey(UInt32(code), UInt32(mods), EventHotKeyID(signature: OSType(0x41495344), id: id), GetApplicationEventTarget(), 0, &ref)
        if st == noErr { hotKeys[id] = ref } else if id == 1 { emit(["type": "error", "code": "hotkey_failed", "message": "RegisterEventHotKey \(st)"]) }
    }
    func navKeys(_ on: Bool) {
        for (id, code) in [(2, kVK_Escape), (3, kVK_UpArrow), (4, kVK_DownArrow), (5, kVK_Return)] { hotKey(UInt32(id), code, 0, on && (id == 2 || model.mode == .list)) }
    }
    func key(_ id: UInt32) {
        switch id {
        case 1: activateOrca(); emit(["type": "hotkey", "action": "next"])
        case 2: back()
        case 3: model.selected = max(0, model.selected - 1)
        case 4: model.selected = min(max(0, model.rowIds.count - 1), model.selected + 1)
        case 5: if let id = model.rowIds[safe: model.selected] { act("open", ["id": id]) }
        default: break
        }
    }
    func registerHotkey() {
        hotKey(1, (config["hotkeyKeyCode"] as? Int) ?? kVK_ANSI_U, (config["hotkeyModifiers"] as? Int) ?? (controlKey | optionKey | shiftKey), (config["hotkey"] as? Bool) ?? true)
    }

    func activateOrca() {
        guard !OFFSCREEN, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: orcaBundleId) else { return }
        let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, err in
            if let err = err { log("openApplication failed: \(err)") }
            DispatchQueue.main.async { // like a Dock click: also brings back a minimized window
                let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); p.arguments = ["-b", self.orcaBundleId]
                try? p.run()
            }
        }
    }

    func reportPresence(force: Bool = false) {
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
        let locked = sessionLocked()
        let key = "\(front)|\(locked)|\(idle > 300)"
        if !force && key == lastPresence { return }
        lastPresence = key
        emit(["type": "presence", "frontmostBundleId": front, "locked": locked, "idleSec": Int(idle)])
    }

    // ---- menu bar mode
    func renderStatusItem() {
        guard let button = statusItem?.button else { return }
        let list = model.list, c = Dictionary(grouping: list, by: { $0.state }).mapValues { $0.count }
        let done = list.filter { $0.state == "done" && $0.unread }.count
        var parts: [String] = []
        if let n = c["needs_you"] { parts.append("! \(n)") }
        if let n = c["failed"] { parts.append("✗ \(n)") }
        if done > 0 { parts.append("✓ \(done)") }
        if let n = c["working"] { parts.append("◌ \(n)") }
        button.attributedTitle = NSAttributedString(string: parts.isEmpty ? "◇" : parts.joined(separator: " "), attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: list.first.map { $0.state == "working" ? NSColor.labelColor : tint($0.state) } ?? NSColor.labelColor])
        button.toolTip = [c["needs_you"].map { countNoun("needs_you", $0) }, c["failed"].map { countNoun("failed", $0) }, done > 0 ? countNoun("done", done) : nil, c["working"].map { countNoun("working", $0) }].compactMap { $0 }.joined(separator: "，")
    }
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        if model.items.isEmpty { menu.addItem(withTitle: "没有活动的 agent", action: nil, keyEquivalent: "").isEnabled = false }
        for g in model.groups {
            let hd = NSMenuItem(title: g.name, action: nil, keyEquivalent: "")
            let at = NSMutableAttributedString(string: g.name + "   ", attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .bold)])
            at.append(countsText(g.counts)); hd.attributedTitle = at; hd.isEnabled = false
            menu.addItem(hd)
            for it in g.sections.flatMap({ $0.ids }).compactMap({ model.items[$0] }) {
                let mi = NSMenuItem(title: "\(SYMBOL[it.state] ?? "•") \(it.title) — \(label(it.state)) \(ago(it.state == "working" ? it.startedAt : it.stateSince))", action: #selector(menuAct(_:)), keyEquivalent: "")
                mi.target = self; mi.representedObject = ["jump", it.id]; mi.indentationLevel = 1; mi.toolTip = it.detail ?? it.sub
                menu.addItem(mi)
            }
        }
        menu.addItem(.separator())
        for (t, a, v) in [("按项目分组", "set_mode", "project"), ("按 Bot 分组", "set_mode", "bot"), ("全部已读", "mark_all_read", ""), ("暂停提醒 30 分钟", "snooze", ""), ("打开 Orca", "open_orca", "")] {
            let mi = NSMenuItem(title: t, action: #selector(menuAct(_:)), keyEquivalent: "")
            mi.target = self; mi.representedObject = [a, v]; mi.state = a == "set_mode" && model.groupMode == v ? .on : .off
            menu.addItem(mi)
        }
        menu.addItem(.separator())
        let off = NSMenuItem(title: "关闭 Island", action: nil, keyEquivalent: ""); off.isEnabled = false
        menu.addItem(off)
        for (t, c) in [("关 1 小时", "hour"), ("关到明早 8 点", "morning"), ("一直关", "forever")] {
            let mi = NSMenuItem(title: t, action: #selector(menuAct(_:)), keyEquivalent: "")
            mi.target = self; mi.representedObject = ["power_off", c]; mi.indentationLevel = 1
            menu.addItem(mi)
        }
    }
    @objc func menuAct(_ s: NSMenuItem) {
        guard let r = s.representedObject as? [String], r.count == 2 else { return }
        act(r[0], r[0] == "jump" ? ["id": r[1]] : r[0] == "set_mode" ? ["mode": r[1]] : r[0] == "power_off" ? ["choice": r[1]] : [:])
    }

    // ---- protocol
    func handle(_ line: String) {
        guard let d = line.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
              let type = m["type"] as? String else { emit(["type": "error", "code": "bad_json", "message": ""]); return }
        switch type {
        case "hello", "config":
            if let o = m["orca"] as? [String: Any], let b = o["bundleId"] as? String { orcaBundleId = b }
            let before = displayMode
            if let c = m["config"] as? [String: Any] { for (k, v) in c { config[k] = v } }
            withAnimation(Motion.expand) { model.allowAnswer = (config["allowAnswer"] as? Bool) ?? false; model.answerGranted = (config["answerGranted"] as? Bool) ?? false }
            if type == "hello" || before != displayMode { rebuild() }
            // Applies at once, without rebuilding the panels or restarting the helper.
            let hide = config["hideFromCapture"] as? Bool ?? true
            for p in screens { p.panel.sharingType = hide ? .none : .readOnly }
            model.hideFromCapture = hide
            registerHotkey()
            if type == "hello" { reportPresence(force: true) }
        case "upsert":
            guard let d = m["item"] as? [String: Any], let it = parseItem(d) else { return }
            let old = model.items[it.id]
            leaving.remove(it.id) // brought back (撤销 or a new event) before its turn to leave
            if old == it { return }
            let count = { self.model.items.values.filter { $0.state == "needs_you" }.count }
            let n = count()
            model.items[it.id] = it
            rebuildLines()
            if model.peek?.id == it.id { model.peek = it }
            if count() > n { bump() }
            refresh()
        case "remove":
            guard let id = m["id"] as? String, model.items[id] != nil, !leaving.contains(id) else { return }
            model.items[id] = nil
            rebuildLines()
            if model.mode == .detail && model.detail.id == id && !model.sending { model.detail.answerable = false; model.detail.options = []; model.status = "已在别处处理" }
            if model.peek?.id == id { endPeek() }
            refresh()
        case "groups":
            let g = ((m["groups"] as? [[String: Any]]) ?? []).compactMap(parseGroup)
            if g != model.groups { model.groups = g; rebuildLines() }
            if let x = m["mode"] as? String, x != model.groupMode { model.groupMode = x }
        case "peek":
            if let s = m["sound"] as? String, !s.isEmpty, !OFFSCREEN { NSSound(named: NSSound.Name(s))?.play() }
            let ttl = (m["ttlMs"] as? Double) ?? 0
            if ttl > 0 {
                if let t = m["title"] as? String, (m["id"] as? String ?? "").isEmpty {
                    pendingSum = (t, (m["lines"] as? [String]) ?? [], (m["ids"] as? [String]) ?? [], (m["badge"] as? String) ?? "")
                }
                showPeek(id: m["id"] as? String, more: (m["more"] as? Int) ?? 0, text: (m["text"] as? String) ?? "", ttl: ttl)
            }
        case "detail":
            guard isOpen, let id = m["id"] as? String, id == model.detail.id else { return }
            let opening = model.mode != .detail
            var x = Detail()
            x.id = id; x.title = (m["title"] as? String) ?? ""; x.source = (m["source"] as? String) ?? ""
            x.question = (m["question"] as? String) ?? ""; x.note = (m["note"] as? String) ?? ""
            x.primary = (m["primary"] as? String) ?? "打开 Orca"; x.signature = (m["signature"] as? String) ?? ""
            x.inputKind = (m["inputKind"] as? String) ?? "none"
            x.asks = ((m["asks"] as? [[String: Any]]) ?? []).map { a in ((a["question"] as? String) ?? "", ((a["options"] as? [[String: Any]]) ?? []).map { (($0["label"] as? String) ?? "", ($0["recommended"] as? Bool) ?? false) }) }
            x.answerable = (m["answerable"] as? Bool) ?? false; x.textOption = m["textOption"] as? Int
            x.options = ((m["options"] as? [[String: Any]]) ?? []).enumerated().map { ((($1["n"] as? Int) ?? $0 + 1), ($1["label"] as? String) ?? "") }
            setDetail(x) { [weak self] in if opening, let s = self, s.isOpen, s.model.detail.id == id { s.go(.detail); s.navKeys(true) } }
            if x.answerable { allowKey() }
        case "hint":
            let text = (m["text"] as? String) ?? ""
            withAnimation(Motion.expand) { model.hint = text }
            if model.mode == .detail { model.status = text }
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in if self?.model.hint == text { withAnimation(Motion.collapse) { self?.model.hint = "" } } }
        case "picked":
            guard (m["id"] as? String) == model.detail.id else { return }
            model.status = (m["text"] as? String) ?? ""
            let id = model.detail.id, text = model.status
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in if let s = self, s.model.detail.id == id, s.model.status == text { s.model.status = "" } }
        case "answered":
            guard (m["id"] as? String) == model.detail.id else { return }
            detailSeq += 1 // a detail still being measured must not undo this
            model.sending = false
            model.status = (m["text"] as? String) ?? ""
            if m["ok"] as? Bool == true {
                model.draft = ""
                let id = model.detail.id
                DispatchQueue.main.asyncAfter(deadline: motionDelay(0.9)) { [weak self] in if let s = self, s.model.mode == .detail, s.model.detail.id == id { s.back() } }
            } else if (m["reason"] as? String) == "gone" { model.detail.answerable = false; model.detail.options = [] }
        case "reset": model.items.removeAll(); rebuildLines(); refresh()
        case "toast": showToast((m["text"] as? String) ?? "", undo: (m["undo"] as? Bool) ?? false)
        case "summary", "clear_unread": break
        case "ping": emit(["type": "pong", "seq": m["seq"] ?? 0]); reportPresence()
        case "quit": NSApp.terminate(nil)
        case "demo_clock": demoNow = m["now"] as? Double; if OFFSCREEN { SLOW = max(1, (m["slow"] as? Double) ?? 1) }
        case "debug_act": act((m["action"] as? String) ?? "", (m["data"] as? [String: Any]) ?? [:])
        case "debug_hover":
            withAnimation(Motion.hover) { model.hoverScreen = (m["inside"] as? Bool) == true ? 0 : -1 }
        case "debug_hover_row": model.rowHover.id = m["id"] as? String // off-screen demos: the pointer over a row
        case "debug_input": awayInput()
        case "debug_away_hover": awaySeen()
        case "debug_activate_other": NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didActivateApplicationNotification, object: NSWorkspace.shared)
        case "debug_key": key(UInt32((m["key"] as? Int) ?? 0))
        case "debug_state":
            emit(["type": "state", "mode": "\(model.mode)", "content": "\(model.contentMode)", "peek": model.peek?.id ?? "", "detail": model.detail.id, "status": model.status, "selected": model.selected, "awayBadge": model.awayBadge, "sumTitle": model.sumTitle, "sumLines": model.sumLines, "locked": sessionLocked(), "peekText": model.peekText, "sharing": screens.first.map { $0.panel.sharingType == .none ? "none" : "readOnly" } ?? "", "hover": model.hoverScreen,
                  "displayMode": displayMode, "items": model.items.count, "powerMenu": model.powerMenu, "hint": model.hint, "pillW": screens.first.map { $0.geo.size(.pill, model).width } ?? 0, "hintW": (model.hint as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold)]).width,
                  "lines": model.lines.map { l -> String in switch l.kind { case .row(let r): return "r:" + r.id; case .section(let n): return "s:" + n; case .group(let n, _, _, let c): return "g:" + n + "|" + c.map { "\($0.symbol)\($0.n)" }.joined() } }, "hotkey": hotKeys[1] != nil, "navKeys": hotKeys.keys.filter { $0 > 1 }.count, "statusItem": statusItem != nil,
                  "panels": screens.map { ["notch": $0.geo.notch, "visible": $0.panel.isVisible, "key": $0.panel.isKeyWindow, "canKey": $0.panel.canBecomeKey, "clickThrough": $0.panel.ignoresMouseEvents,
                                           "w": $0.hit.width, "h": $0.hit.height, "frame": NSStringFromRect($0.panel.frame), "screen": $0.screen.localizedName] }])
        case "record": // demo frames: the island's own view, never the screen
            // SwiftUI animates on the real clock, so the shape is sampled at a steady pace: each frame
            // is drawn when due and written later. With demo_clock `slow`, motion runs SLOW times
            // slower and frames are SLOW/fps apart, so a slow draw still lands on time. Late ones are reported.
            guard let sc = screens.first, let dir = m["dir"] as? String else { return }
            let fps = (m["fps"] as? Double) ?? 30, count = (m["frames"] as? Int) ?? 30, scale = (m["scale"] as? Double) ?? 2
            let b = sc.host.bounds
            var reps: [NSBitmapImageRep] = [], late = 0
            let t0 = CACurrentMediaTime()
            var i = 0
            func step() {
                let due = t0 + Double(i) * SLOW / fps
                let now = CACurrentMediaTime()
                if now - due > 0.5 * SLOW / fps { late += 1 }
                // The presentation layer tree is what is on screen at this instant (mid-animation).
                if let root = sc.host.layer?.presentation() ?? sc.host.layer,
                   let ctx = CGContext(data: nil, width: Int(b.width * scale), height: Int(b.height * scale), bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                    // CoreGraphics is y-up; the layer tree is drawn y-down.
                    ctx.translateBy(x: 0, y: CGFloat(ctx.height)); ctx.scaleBy(x: scale, y: -scale)
                    root.render(in: ctx)
                    if let img = ctx.makeImage() { reps.append(NSBitmapImageRep(cgImage: img)) }
                }
                i += 1
                if i < count {
                    let next = t0 + Double(i) * SLOW / fps - CACurrentMediaTime()
                    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, next)) { step() }
                } else {
                    for (k, r) in reps.enumerated() { try? r.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: "\(dir)/f\(String(format: "%04d", k)).png")) }
                    emit(["type": "recorded", "frames": reps.count, "late": late, "seconds": CACurrentMediaTime() - t0])
                }
            }
            step()
        case "snap": // draws the island's own view into a PNG: never reads the screen
            guard let s = screens.first, let path = m["path"] as? String, let rep = s.host.bitmapImageRepForCachingDisplay(in: s.host.bounds) else { return }
            s.host.cacheDisplay(in: s.host.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            if let pr = m["probe"] as? [Double], pr.count == 4 { // brightest channel in a rect (points, y down)
                let k = CGFloat(rep.pixelsHigh) / s.host.bounds.height
                var mx = 0
                for y in stride(from: Int(pr[1] * k), to: min(rep.pixelsHigh, Int(pr[3] * k)), by: 1) {
                    for x in stride(from: Int(pr[0] * k), to: min(rep.pixelsWide, Int(pr[2] * k)), by: 1) {
                        if let c = rep.colorAt(x: x, y: y) { mx = max(mx, Int((max(c.redComponent, c.greenComponent, c.blueComponent) * c.alphaComponent * 255).rounded())) }
                    }
                }
                emit(["type": "snapped", "max": mx]); return
            }
            if let pr = m["ink"] as? [Double], pr.count == 4 { // bounding box (points) of light pixels in a rect
                let k = CGFloat(rep.pixelsHigh) / s.host.bounds.height
                var x0 = Int.max, y0 = Int.max, x1 = -1, y1 = -1
                for y in Int(pr[1] * k)..<min(rep.pixelsHigh, Int(pr[3] * k)) {
                    for x in Int(pr[0] * k)..<min(rep.pixelsWide, Int(pr[2] * k)) {
                        if let c = rep.colorAt(x: x, y: y), c.alphaComponent > 0.5, c.brightnessComponent > 0.45 { x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y) }
                    }
                }
                emit(["type": "snapped", "ink": x1 < 0 ? [] : [Double(x0) / k, Double(y0) / k, Double(x1 + 1) / k, Double(y1 + 1) / k]]); return
            }
            guard m["lit"] as? Bool == true else { return }
            var lit = 0 // light pixels below the bar: is the content really drawn?
            let k = CGFloat(rep.pixelsHigh) / s.host.bounds.height
            for y in stride(from: Int((s.geo.barH + 10) * k), to: rep.pixelsHigh, by: 6) { for x in stride(from: 0, to: rep.pixelsWide, by: 6) { if let c = rep.colorAt(x: x, y: y), c.alphaComponent > 0.9, c.brightnessComponent > 0.5 { lit += 1 } } }
            emit(["type": "snapped", "lit": lit])
        default: emit(["type": "error", "code": "unknown_type", "message": type])
        }
    }
    func bump() {
        guard !model.reduceMotion else { return }
        withAnimation(Motion.spring(0.22, 0.5)) { model.bump = true }
        DispatchQueue.main.asyncAfter(deadline: motionDelay(0.28)) { withAnimation(Motion.spring(0.4, 0.7)) { self.model.bump = false } }
    }
}

// MARK: - main

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let island = Island()

let lock = acquireSingleton()
if !lock.ok {
    emit(["type": "error", "code": "already_running", "message": "another island helper holds the lock (pid \(lock.holder))"])
    exit(3)
}
NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { _ in island.rebuild() }
let wnc = NSWorkspace.shared.notificationCenter
for n in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
    wnc.addObserver(forName: n, object: nil, queue: .main) { _ in island.rebuild() }
}
wnc.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in island.refresh(force: true) }
// Not closed here: another app coming forward (a screenshot tool, say) must not take the card away.
wnc.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in island.reportPresence() }
let dnc = DistributedNotificationCenter.default()
dnc.addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { _ in island.screenLocked = true; island.reportPresence() }
dnc.addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { _ in island.screenLocked = false; island.reportPresence() }
// While typing, Esc comes from the key window instead of the global key.
NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { _ in island.navKeys(false) }
NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: nil, queue: .main) { _ in if island.isOpen { island.navKeys(true) } }
Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in island.reportPresence() }

Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        DispatchQueue.main.async { island.handle(line) }
    }
    log("stdin EOF, exiting")
    DispatchQueue.main.async { exit(0) }
}
emit(["type": "ready", "version": VERSION, "impl": "swift", "pid": Int(getpid()), "screens": island.screensInfo()])
app.run()
