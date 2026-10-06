import SwiftUI
import RemoteKit

/// One entry of the agent's recent meaningful output (messages + tool calls merged by time).
struct OutputItem: Identifiable, Equatable {
    enum Kind: Equatable {
        case message(role: String, text: String)
        case tool(name: String, summary: String?, status: String?)
    }
    let id: String
    let kind: Kind
    let at: Date?

    static func merge(_ detail: AgentDetail, limit: Int = 40) -> [OutputItem] {
        var items: [OutputItem] = []
        for (i, m) in detail.messages.enumerated() {
            guard let text = m.text?.nonEmpty else { continue }
            items.append(OutputItem(id: "m\(i)", kind: .message(role: m.role ?? "assistant", text: text), at: m.at))
        }
        for (i, t) in detail.tools.enumerated() {
            items.append(OutputItem(id: "t\(i)", kind: .tool(name: t.name ?? "tool", summary: t.summary, status: t.status), at: t.at))
        }
        // Stable merge: by time when both have one, else keep source order.
        let sorted = items.enumerated().sorted { a, b in
            switch (a.element.at, b.element.at) {
            case let (x?, y?) where x != y: return x < y
            default: return a.offset < b.offset
            }
        }.map(\.element)
        return Array(sorted.suffix(limit))
    }
}

struct AgentDetailView: View {
    let agentId: String
    @Environment(AppModel.self) private var model
    @Environment(\.isSplitPane) private var isSplitPane
    @Environment(\.dismiss) private var dismiss

    @State private var detail: AgentDetail?
    @State private var loading = false
    @State private var loadError: String?
    @State private var seen = false
    @State private var busyAction: String?
    @State private var confirmStop = false
    @State private var showLogSheet = false
    @State private var actionsWidth: CGFloat = 400

    private var live: Agent? { model.client.fleet.agent(agentId) }
    private var agent: Agent? { live ?? detail?.agent }

    var body: some View {
        let online = model.client.status.isOnline
        let stale = !online
        Group {
            if let agent {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        ConnectionBanner()
                        VStack(alignment: .leading, spacing: 18) {
                            AgentHeaderCard(agent: agent, worktree: WorktreeInfo(detail?.worktree))
                            blockers(agent)
                            actions(agent, online: online)
                            result(agent)
                            output
                        }
                        .staleDimmed(stale)
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.top, 6)
                    .padding(.bottom, 20)
                    .frame(maxWidth: Metrics.readable)
                    .frame(maxWidth: .infinity)
                }
                .scrollDismissesKeyboard(.interactively)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    PromptComposer(agent: agent)
                }
            } else if model.client.fleet.hasSnapshot {
                EmptyStateView(symbol: "flag.checkered", title: "This agent has finished",
                               message: "It's no longer running on \(model.workstationName).",
                               action: ("Back to Mission Control", { model.router.agentGone(agentId) }))
            } else {
                VStack { LoadingRow(text: "Loading agent…") }.padding(Metrics.gutter)
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .background(Palette.bg.ignoresSafeArea())
        .toolbar(isSplitPane ? .automatic : .hidden, for: .tabBar)
        .paneTitle(agent?.workspaceName?.nonEmpty ?? "Agent", subtitle: agent?.providerName) {
            if isSplitPane {
                Button {
                    Haptics.tap()
                    withAnimation(Motion.standard) { model.router.diffBeside.toggle() }
                } label: {
                    Image(systemName: model.router.diffBeside ? "rectangle.righthalf.inset.filled" : "rectangle.split.2x1")
                }
                .buttonStyle(IconCircleButtonStyle(size: 34, tint: model.router.diffBeside ? Palette.accentText : Palette.text2))
                .accessibilityLabel(model.router.diffBeside ? "Hide changes" : "Show changes beside")
                .accessibilityIdentifier("agent.diffToggle")
                Button {
                    model.router.selectedAgentId = nil
                    model.router.selectedNeedsAgentId = nil
                    model.router.selectedNeedsId = nil
                    model.router.diffBeside = false
                } label: {
                    Image(systemName: "xmark")
                }
                .buttonStyle(IconCircleButtonStyle(size: 34))
                .accessibilityLabel("Close agent")
                .accessibilityIdentifier("agent.close")
            }
        }
        .confirmationDialog("Stop \(agent?.displayName ?? "this agent")?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Stop agent", role: .destructive) { perform("agent.stop", success: "Stopping") }
                .accessibilityIdentifier("agent.stop.confirm")
            Button("Keep running", role: .cancel) {}
        } message: {
            Text("It stops where it is. Its changes stay in the worktree.")
        }
        .sheet(isPresented: $showLogSheet) {
            NavigationStack { AgentLogView(agentId: agentId, inSheet: true) }
                .environment(model)
                .environment(\.liveness, model.liveness)
        }
        .task(id: refreshKey) { await load() }
        .onAppear { if live != nil { seen = true } }
        .onChange(of: live == nil) { _, missing in
            if !missing { seen = true; return }
            guard seen, model.client.fleet.hasSnapshot else { return }
            model.show("This agent has finished", style: .info)
            model.router.agentGone(agentId)
        }
    }

    /// Refetch whenever the agent reports new activity, or the connection comes back.
    private var refreshKey: String {
        "\(live?.lastActivityAt?.timeIntervalSince1970 ?? 0)|\(live?.state.rawValue ?? "")|\(model.client.status.isOnline)"
    }

    private func load(force: Bool = false) async {
        guard model.client.status.isOnline else { return }
        if detail != nil && !force { try? await Task.sleep(nanoseconds: 250_000_000) }  // coalesce bursts of patches
        if Task.isCancelled { return }
        if detail == nil { loading = true }
        defer { loading = false }
        do {
            let d: AgentDetail = try await model.call("agent.detail", ["agentId": .string(agentId)])
            detail = d
            loadError = nil
        } catch {
            if Task.isCancelled { return }
            if ErrorCopy.isNotFound(error) {
                if seen || model.client.fleet.hasSnapshot {
                    model.show("This agent has finished", style: .info)
                    model.router.agentGone(agentId)
                }
                return
            }
            loadError = model.errorText(error, target: .agent)
        }
    }

    // MARK: Sections

    @ViewBuilder
    private func blockers(_ agent: Agent) -> some View {
        // The error banner below already says why it failed; don't repeat it as a blocker.
        let items = model.client.fleet.needsYou(forAgent: agentId).filter { !($0.kind == .failed && agent.error?.nonEmpty != nil) }
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Needs you", count: items.count, tone: .amber)
                ForEach(items) { item in
                    NeedsYouCard(item: item) {}
                }
            }
        }
        if let error = agent.error?.nonEmpty {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Palette.red)
                    .font(.system(size: 15, weight: .semibold))
                VStack(alignment: .leading, spacing: 4) {
                    Text("The agent hit an error").font(.kcSubMedium).foregroundStyle(Palette.text)
                    Text(error).font(.kcMonoSmall).foregroundStyle(Palette.redText).textSelection(.enabled)
                }
                Spacer(minLength: 0)
            }
            .card(padding: 14, edge: Palette.red.opacity(0.35))
            .accessibilityElement(children: .combine)
        }
    }

    @ViewBuilder
    private func result(_ agent: Agent) -> some View {
        if agent.state.isFinished,
           let last = detail?.messages.last(where: { ($0.role ?? "") == "assistant" && $0.text?.nonEmpty != nil })?.text {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Result", tone: .green)
                Text(last)
                    .font(.kcCallout)
                    .foregroundStyle(Palette.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .card(padding: 14, edge: Palette.green.opacity(0.28))
            }
        }
    }

    private func actions(_ agent: Agent, online: Bool) -> some View {
        let canStop = agent.state.isActive || agent.state.needsAttention
        let canRetry = agent.state == .failed || agent.state == .stopped
        let buttons = Group {
            if !isSplitPane {
                Button {
                    Haptics.tap()
                    model.router.push(.diff(agentId))
                } label: {
                    Label(diffLabel(agent), systemImage: "plusminus")
                }
                .buttonStyle(SecondaryButtonStyle(compact: true))
                .accessibilityIdentifier("agent.diff")
            } else {
                Button {
                    Haptics.tap()
                    model.router.diffBeside = true
                } label: {
                    Label(diffLabel(agent), systemImage: "plusminus")
                }
                .buttonStyle(SecondaryButtonStyle(compact: true))
                .accessibilityIdentifier("agent.diff")
            }
            Button {
                Haptics.tap()
                if isSplitPane { showLogSheet = true } else { model.router.push(.log(agentId)) }
            } label: {
                Label("Full log", systemImage: "text.alignleft")
            }
            .buttonStyle(SecondaryButtonStyle(compact: true))
            .accessibilityIdentifier("agent.log")

            if canRetry {
                Button {
                    perform("agent.retry", success: "Retrying")
                } label: {
                    busyLabel("agent.retry", title: "Retry", symbol: "arrow.clockwise")
                }
                .buttonStyle(PrimaryButtonStyle(compact: true))
                .disabled(!online || busyAction != nil)
                .accessibilityIdentifier("agent.retry")
            }
            if canStop {
                Button {
                    Haptics.warning()
                    confirmStop = true
                } label: {
                    busyLabel("agent.stop", title: "Stop", symbol: "stop.fill")
                }
                .buttonStyle(DestructiveButtonStyle(compact: true))
                .disabled(!online || busyAction != nil)
                .accessibilityIdentifier("agent.stop")
            }
        }
        let count = 2 + (canRetry ? 1 : 0) + (canStop ? 1 : 0)
        return Group {
            if actionsWidth >= CGFloat(count) * 118 {
                HStack(spacing: 10) { buttons }
            } else {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) { buttons }
            }
        }
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { actionsWidth = $0 }
    }

    private func diffLabel(_ agent: Agent) -> String {
        return "Changes"
    }

    @ViewBuilder
    private func busyLabel(_ op: String, title: String, symbol: String) -> some View {
        if busyAction == op {
            ProgressView().controlSize(.small)
        } else {
            Label(title, systemImage: symbol)
        }
    }

    @ViewBuilder
    private var output: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Recent output")
            if let detail {
                let items = OutputItem.merge(detail)
                if items.isEmpty {
                    Text("No output yet.")
                        .font(.kcSub)
                        .foregroundStyle(Palette.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .card(padding: 14)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(items) { OutputRow(item: $0, provider: agent?.providerName) }
                    }
                }
            } else if let loadError {
                InlineErrorCard(title: "Couldn't load this agent's output", message: loadError) {
                    Task { await load() }
                }
            } else if loading {
                LoadingRow(text: "Loading output…")
            } else if !model.client.status.isOnline {
                Text("Output loads when \(model.workstationName) is connected.")
                    .font(.kcSub)
                    .foregroundStyle(Palette.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .card(padding: 14)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("agent.output")
    }

    private func perform(_ op: String, success: String) {
        busyAction = op
        Haptics.tap()
        Task {
            do {
                let r: SummaryResult = try await model.call(op, ["agentId": .string(agentId)])
                Haptics.success()
                model.show(r.summary?.nonEmpty ?? success, style: .success)
            } catch {
                Haptics.error()
                model.show(model.errorText(error, target: .agent), style: ErrorCopy.toastStyle(error))
                if ErrorCopy.isNotFound(error) { model.router.agentGone(agentId) }
                if ErrorCopy.isConflict(error) { await load(force: true) }
            }
            busyAction = nil
        }
    }
}

// MARK: - Header

struct AgentHeaderCard: View {
    let agent: Agent
    let worktree: WorktreeInfo?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                StateChip(state: agent.state)
                Spacer(minLength: 0)
                AgentElapsed(agent: agent, font: .kcMono)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(agent.displayName)
                    .font(.kcTitle2)
                    .foregroundStyle(Palette.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let activity = agent.activity?.nonEmpty, agent.error == nil {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "chevron.right.2").font(.system(size: 9, weight: .bold))
                            .foregroundStyle(agent.state.tone.fill)
                        Text(activity).font(.kcSub).foregroundStyle(Palette.text2)
                    }
                }
            }

            Hairline()

            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 10) {
                if let provider = (agent.providerName ?? agent.providerId)?.nonEmpty {
                    row("Provider", value: [provider, agent.accountLabel].compactMap { $0?.nonEmpty }.joined(separator: " · "))
                }
                if agent.model != nil || agent.effort != nil {
                    GridRow {
                        label("Model")
                        HStack(spacing: 6) {
                            if let m = agent.model?.nonEmpty { MonoChip(text: m) }
                            if let e = agent.effort?.nonEmpty { MonoChip(text: e) }
                        }
                    }
                }
                if let ws = agent.workspaceName?.nonEmpty {
                    row("Project", value: ws)
                }
                let branch = worktree?.branch ?? agent.branch
                if let branch = branch?.nonEmpty {
                    GridRow {
                        label("Branch")
                        HStack(spacing: 8) {
                            Text(branch).font(.kcMonoSmall).foregroundStyle(Palette.icy).lineLimit(1).truncationMode(.middle)
                            if agent.worktree == true || worktree != nil {
                                Tag(text: "worktree", tone: .accent, symbol: "square.stack.3d.up.fill")
                            }
                        }
                    }
                }
                if let base = worktree?.baseBranch?.nonEmpty {
                    GridRow {
                        label("From")
                        Text(base).font(.kcMonoSmall).foregroundStyle(Palette.text2).lineLimit(1)
                    }
                }
                if let path = worktree?.path?.nonEmpty {
                    GridRow {
                        label("Path")
                        Text(path).font(.kcMonoSmall).foregroundStyle(Palette.faint).lineLimit(1).truncationMode(.head)
                            .textSelection(.enabled)
                    }
                }
                if let files = agent.filesChanged, files > 0 {
                    row("Changed", value: Plural.s(files, "file"))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 16, edge: agent.state == .needsYou ? Palette.amber.opacity(0.4) : nil)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("agent.header")
    }

    private func label(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.kcLabel)
            .tracking(0.9)
            .foregroundStyle(Palette.faint)
            .gridColumnAlignment(.leading)
    }

    private func row(_ title: String, value: String) -> some View {
        GridRow {
            label(title)
            Text(value).font(.kcSub).foregroundStyle(Palette.text2).lineLimit(2)
        }
    }
}

// MARK: - Output row

private struct OutputRow: View {
    let item: OutputItem
    let provider: String?

    var body: some View {
        switch item.kind {
        case let .message(role, text):
            if role == "user" {
                HStack {
                    Spacer(minLength: 40)
                    VStack(alignment: .trailing, spacing: 4) {
                        Text("You").font(.kcLabel).tracking(0.8).foregroundStyle(Palette.accentText)
                        Text(text)
                            .font(.kcSub)
                            .foregroundStyle(Palette.text)
                            .multilineTextAlignment(.leading)
                            .textSelection(.enabled)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.accent.opacity(0.16)))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.litSoft, lineWidth: 0.75))
                    }
                }
                .accessibilityElement(children: .combine)
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text((role == "assistant" ? (provider ?? "Agent") : role.capitalized).uppercased())
                            .font(.kcLabel).tracking(0.8).foregroundStyle(Palette.muted)
                        if let at = item.at { RelativeLabel(date: at, font: .kcCaption) }
                    }
                    Text(text)
                        .font(.kcSub)
                        .foregroundStyle(role == "assistant" ? Palette.text : Palette.text2)
                        .textSelection(.enabled)
                        .lineLimit(14)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .card(padding: 12, radius: 12)
                .accessibilityElement(children: .combine)
            }
        case let .tool(name, summary, status):
            let tone = toolTone(status)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: toolSymbol(status))
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(tone.fill)
                    .frame(width: 14)
                Text(name).font(.kcMonoMedium).foregroundStyle(Palette.icy).lineLimit(1)
                if let summary = summary?.nonEmpty {
                    Text(summary).font(.kcMonoSmall).foregroundStyle(Palette.text2).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.codeBg))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 0.75))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Tool \(name), \(status ?? ""), \(summary ?? "")")
        }
    }

    private func toolTone(_ status: String?) -> Tone {
        switch status?.lowercased() {
        case "failed", "error", "denied": return .red
        case "running", "pending", "in_progress": return .blue
        case "waiting", "needs_approval": return .amber
        default: return .green
        }
    }

    private func toolSymbol(_ status: String?) -> String {
        switch toolTone(status) {
        case .red: return "xmark"
        case .blue: return "circle.dotted"
        case .amber: return "hand.raised.fill"
        default: return "checkmark"
        }
    }
}
