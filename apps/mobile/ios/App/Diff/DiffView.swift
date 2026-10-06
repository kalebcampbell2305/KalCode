import SwiftUI
import RemoteKit

/// The agent's working changes. A quiet surface: no stars or nebula behind code.
struct DiffView: View {
    let agentId: String
    @Environment(AppModel.self) private var model
    @Environment(\.isSplitPane) private var isSplitPane

    @State private var diff: AgentDiff?
    @State private var loading = false
    @State private var error: String?
    @State private var collapsed: Set<String> = []

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ConnectionBanner()
                if let diff {
                    summary(diff)
                    ForEach(diff.files) { file in
                        DiffFileSection(file: file, collapsed: collapsed.contains(file.path)) {
                            Haptics.select()
                            withAnimation(Motion.quick) {
                                if collapsed.contains(file.path) { collapsed.remove(file.path) } else { collapsed.insert(file.path) }
                            }
                        }
                    }
                    if diff.truncated {
                        HStack(spacing: 10) {
                            Image(systemName: "scissors").foregroundStyle(Palette.amber)
                            Text("This diff is large, so it was cut short. Open it on \(model.workstationName) to see everything.")
                                .font(.kcFootnote)
                                .foregroundStyle(Palette.text2)
                        }
                        .card(padding: 12, radius: 12, edge: Palette.amber.opacity(0.28))
                        .accessibilityIdentifier("diff.truncated")
                    }
                } else if let error {
                    InlineErrorCard(title: "Couldn't load the changes", message: error) { Task { await load() } }
                } else if loading {
                    LoadingRow(text: "Loading changes…")
                } else if !model.client.status.isOnline {
                    EmptyStateView(symbol: "plusminus", title: "Changes load when connected",
                                   message: "Reconnect to \(model.workstationName) to see this agent's diff.")
                }
            }
            .padding(Metrics.gutter)
            .frame(maxWidth: 1100)
            .frame(maxWidth: .infinity)
        }
        .background(Palette.bg.ignoresSafeArea())
        .refreshable { await load() }
        .toolbar(.hidden, for: .tabBar)
        .paneTitle("Changes", subtitle: model.client.fleet.agent(agentId)?.displayName) {
            if isSplitPane {
                Button {
                    withAnimation(Motion.standard) { model.router.diffBeside = false }
                } label: { Image(systemName: "xmark") }
                .buttonStyle(IconCircleButtonStyle(size: 34))
                .accessibilityLabel("Close changes")
                .accessibilityIdentifier("diff.close")
            }
        }
        .task(id: "\(model.client.status.isOnline)|\(model.client.fleet.agent(agentId)?.filesChanged ?? -1)") {
            if diff == nil || model.client.status.isOnline { await load() }
        }
        .accessibilityIdentifier("diff.view")
    }

    private func summary(_ diff: AgentDiff) -> some View {
        let adds = diff.files.reduce(0) { $0 + ($1.additions ?? 0) }
        let dels = diff.files.reduce(0) { $0 + ($1.deletions ?? 0) }
        return HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(diff.files.isEmpty ? "No changes yet" : Plural.s(diff.files.count, "file") + " changed")
                    .font(.kcHeadline)
                    .foregroundStyle(Palette.text)
                if let agent = model.client.fleet.agent(agentId), let branch = agent.branch {
                    Text(branch).font(.kcMonoSmall).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
            if !diff.files.isEmpty {
                Text("+\(adds)").font(.mono(14, weight: .medium)).foregroundStyle(Palette.greenText)
                Text("−\(dels)").font(.mono(14, weight: .medium)).foregroundStyle(Palette.redText)
                DiffStatBar(adds: adds, dels: dels)
            }
        }
        .card(padding: 14)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Plural.s(diff.files.count, "file")) changed, \(adds) additions, \(dels) deletions")
        .accessibilityIdentifier("diff.summary")
    }

    private func load() async {
        guard !loading else { return }
        loading = diff == nil
        defer { loading = false }
        do {
            let d: AgentDiff = try await model.call("agent.diff", ["agentId": .string(agentId), "maxBytes": .number(800_000)])
            diff = d
            error = nil
            if d.files.count > 12 && collapsed.isEmpty {
                collapsed = Set(d.files.dropFirst(3).map(\.path))  // big diffs open compact
            }
        } catch {
            if ErrorCopy.isNotFound(error) {
                model.show("This agent has finished", style: .info)
                model.router.agentGone(agentId)
                return
            }
            if diff == nil { self.error = model.errorText(error, target: .agent) }
        }
    }
}

/// Five-segment add/delete bar, like a code review summary.
private struct DiffStatBar: View {
    var adds: Int
    var dels: Int
    var body: some View {
        let total = max(adds + dels, 1)
        let green = Int((Double(adds) / Double(total) * 5).rounded())
        HStack(spacing: 2) {
            ForEach(0..<5, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(i < green ? Palette.green : Palette.red)
                    .frame(width: 7, height: 7)
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - File

private struct DiffFileSection: View {
    let file: DiffFile
    let collapsed: Bool
    let toggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 10) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Palette.faint)
                        .rotationEffect(.degrees(collapsed ? 0 : 90))
                    FileStatusBadge(status: file.status)
                    Text(file.path)
                        .font(.kcMono)
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let a = file.additions { Text("+\(a)").font(.kcMonoMedium).foregroundStyle(Palette.greenText) }
                    if let d = file.deletions { Text("−\(d)").font(.kcMonoMedium).foregroundStyle(Palette.redText) }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(file.path), \(FileStatusBadge.word(file.status)), \(file.additions ?? 0) added, \(file.deletions ?? 0) removed")
            .accessibilityHint(collapsed ? "Expands the file" : "Collapses the file")
            .accessibilityIdentifier("diff.file.\(file.path)")

            if !collapsed {
                if file.hunks.isEmpty {
                    Text(file.status?.lowercased().hasPrefix("bin") == true ? "Binary file" : "No text changes to show")
                        .font(.kcFootnote)
                        .foregroundStyle(Palette.muted)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 12)
                } else {
                    ForEach(Array(file.hunks.enumerated()), id: \.offset) { _, hunk in
                        DiffHunkView(hunk: hunk)
                    }
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.surface1))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.border, lineWidth: 0.75))
    }
}

struct FileStatusBadge: View {
    var status: String?

    static func letter(_ s: String?) -> String {
        switch s?.lowercased() {
        case "added", "a", "new", "untracked": return "A"
        case "deleted", "d", "removed": return "D"
        case "renamed", "r": return "R"
        case "copied", "c": return "C"
        default: return "M"
        }
    }

    static func word(_ s: String?) -> String {
        switch letter(s) {
        case "A": return "added"
        case "D": return "deleted"
        case "R": return "renamed"
        case "C": return "copied"
        default: return "modified"
        }
    }

    var body: some View {
        let l = Self.letter(status)
        let tone: Tone = l == "A" ? .green : l == "D" ? .red : l == "R" || l == "C" ? .blue : .amber
        Text(l)
            .font(.mono(11, weight: .bold, relativeTo: .caption2))
            .foregroundStyle(tone.text)
            .frame(width: 20, height: 20)
            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(tone.wash))
            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(tone.edge, lineWidth: 0.75))
    }
}

// MARK: - Hunk

private struct DiffRow: Identifiable {
    let id: Int
    let number: Int?
    let kind: DiffLineKind
    let text: String
}

private struct DiffHunkView: View {
    let hunk: DiffHunk
    @State private var viewport: CGFloat = 0
    static let maxLines = 800

    private var rows: [DiffRow] {
        // "@@ -12,7 +14,9 @@" → old 12, new 14.
        var old = 0, new = 0
        let scanner = hunk.header
        if let minus = scanner.range(of: "-"), let plus = scanner.range(of: "+", range: minus.upperBound..<scanner.endIndex) {
            old = Int(scanner[minus.upperBound...].prefix { $0.isNumber }) ?? 0
            new = Int(scanner[plus.upperBound...].prefix { $0.isNumber }) ?? 0
        }
        var out: [DiffRow] = []
        out.reserveCapacity(min(hunk.lines.count, Self.maxLines))
        for (i, line) in hunk.lines.prefix(Self.maxLines).enumerated() {
            let n: Int?
            switch line.kind {
            case .add: n = new; new += 1
            case .delete: n = old; old += 1
            case .context: n = new; new += 1; old += 1
            case .meta: n = nil
            }
            let text = line.text.replacingOccurrences(of: "\t", with: "    ")
            out.append(DiffRow(id: i, number: n == 0 ? nil : n, kind: line.kind, text: text.isEmpty ? " " : text))
        }
        return out
    }

    var body: some View {
        let rows = self.rows
        VStack(alignment: .leading, spacing: 0) {
            if !hunk.header.isEmpty {
                Text(hunk.header)
                    .font(.kcMonoSmall)
                    .foregroundStyle(Palette.icy.opacity(0.85))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.accent.opacity(0.08))
                    .overlay(alignment: .top) { Hairline() }
            }
            HStack(alignment: .top, spacing: 0) {
                // Line numbers stay pinned while the code scrolls sideways.
                VStack(alignment: .trailing, spacing: 0) {
                    ForEach(rows) { row in
                        Text(row.number.map(String.init) ?? " ")
                            .font(.kcCode)
                            .foregroundStyle(row.kind == .context ? Palette.faint.opacity(0.7) : sign(row.kind).color.opacity(0.75))
                            .lineLimit(1)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 1)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                            .background(gutterFill(row.kind))
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
                .accessibilityHidden(true)

                ScrollView(.horizontal, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(rows) { row in
                            HStack(spacing: 0) {
                                Text(sign(row.kind).glyph)
                                    .foregroundStyle(sign(row.kind).color)
                                    .frame(width: 16, alignment: .center)
                                Text(row.text)
                                    .foregroundStyle(row.kind == .meta ? Palette.faint : Palette.text)
                                    .italic(row.kind == .meta)
                            }
                            .font(.kcCode)
                            .lineLimit(1)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(.vertical, 1)
                            .padding(.trailing, 16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(lineFill(row.kind))
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("\(sign(row.kind).spoken) \(row.text)")
                        }
                    }
                    .frame(minWidth: viewport, alignment: .leading)
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { viewport = $0 }
            }
            .background(Palette.codeBg)
            if hunk.lines.count > Self.maxLines {
                Text("\(hunk.lines.count - Self.maxLines) more lines not shown")
                    .font(.kcCaption)
                    .foregroundStyle(Palette.muted)
                    .padding(10)
                    .frame(maxWidth: .infinity)
                    .background(Palette.codeBg)
            }
        }
    }

    private func sign(_ kind: DiffLineKind) -> (glyph: String, color: Color, spoken: String) {
        switch kind {
        case .add: return ("+", Palette.greenText, "added")
        case .delete: return ("−", Palette.redText, "removed")
        case .context: return (" ", Palette.faint, "")
        case .meta: return ("\\", Palette.faint, "note")
        }
    }

    private func lineFill(_ kind: DiffLineKind) -> Color {
        switch kind {
        case .add: return Palette.diffAdd
        case .delete: return Palette.diffDel
        default: return .clear
        }
    }

    private func gutterFill(_ kind: DiffLineKind) -> Color {
        switch kind {
        case .add: return Palette.diffAddGutter
        case .delete: return Palette.diffDelGutter
        default: return Palette.sunken
        }
    }
}
