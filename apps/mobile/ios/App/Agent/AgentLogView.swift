import SwiftUI
import RemoteKit

/// Deep log, loaded on demand and paged backwards with `beforeId` (protocol §5, §8).
struct AgentLogView: View {
    let agentId: String
    var inSheet = false
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var entries: [LogEntry] = []
    @State private var more = false
    @State private var cursor: String?
    @State private var loading = false
    @State private var error: String?
    @State private var loadedOnce = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if more {
                        Button {
                            Task { await load(older: true) }
                        } label: {
                            if loading { ProgressView().controlSize(.small) } else { Label("Load earlier", systemImage: "arrow.up") }
                        }
                        .buttonStyle(SecondaryButtonStyle(compact: true, fullWidth: false))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .disabled(loading || !model.client.status.isOnline)
                        .accessibilityIdentifier("log.loadEarlier")
                    }
                    if let error {
                        InlineErrorCard(title: "Couldn't load the log", message: error) { Task { await load(older: !entries.isEmpty) } }
                            .padding(.bottom, 12)
                    }
                    if entries.isEmpty && loadedOnce && error == nil {
                        EmptyStateView(symbol: "text.alignleft", title: "No log yet", message: "This agent hasn't written anything yet.")
                    }
                    ForEach(entries) { entry in
                        LogRow(entry: entry).id(entry.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.codeBg))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 0.75))
                .padding(Metrics.gutter)
                .frame(maxWidth: 980)
                .frame(maxWidth: .infinity)
            }
            .overlay {
                if !loadedOnce && loading { ProgressView().tint(Palette.accentText) }
            }
            .onChange(of: loadedOnce) { _, done in
                if done { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                NavTitle(title: "Full log", subtitle: model.client.fleet.agent(agentId)?.displayName)
            }
            if inSheet {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { if !loadedOnce { await load(older: false) } }
        .accessibilityIdentifier("log.view")
    }

    private func load(older: Bool) async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        var args: [String: JSONValue] = ["agentId": .string(agentId)]
        if older, let cursor { args["beforeId"] = .string(cursor) }
        do {
            let page: AgentLogPage = try await model.call("agent.log", args)
            let fresh = page.typedEntries
            // §8: an older page exists when `more`; continue from this page's last id.
            cursor = fresh.last?.id ?? cursor
            more = page.more
            entries = Self.chronological(older ? fresh + entries : fresh)
            error = nil
        } catch {
            self.error = model.errorText(error, target: .agent)
        }
        loadedOnce = true
    }

    /// Oldest first, whatever order pages arrive in.
    private static func chronological(_ items: [LogEntry]) -> [LogEntry] {
        var unique: [String: LogEntry] = [:]
        var order: [String] = []
        for e in items where unique[e.id] == nil { unique[e.id] = e; order.append(e.id) }
        let list = order.compactMap { unique[$0] }
        guard list.allSatisfy({ $0.at != nil }) else { return list }
        return list.enumerated().sorted { a, b in
            if a.element.at! != b.element.at! { return a.element.at! < b.element.at! }
            return a.offset < b.offset
        }.map(\.element)
    }
}

private struct LogRow: View {
    let entry: LogEntry

    private var tone: Tone {
        switch entry.kind.lowercased() {
        case "error", "stderr", "failed": return .red
        case "user", "prompt": return .accent
        case "tool", "command": return .blue
        case "assistant", "message": return .bright
        default: return .muted
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(entry.kind.prefix(10).lowercased())
                .font(.kcMonoSmall)
                .foregroundStyle(tone.text.opacity(0.85))
                .frame(width: 80, alignment: .leading)
                .lineLimit(1)
            Text(entry.text)
                .font(.kcCode)
                .foregroundStyle(tone == .red ? Palette.redText : Palette.text2)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}
