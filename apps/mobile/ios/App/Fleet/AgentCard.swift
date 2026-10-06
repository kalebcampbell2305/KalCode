import SwiftUI
import RemoteKit

/// One agent in the fleet. Equatable so a patch to one agent never re-renders the other 199.
struct AgentCard: View, Equatable {
    let agent: Agent
    var selected = false

    static func == (a: AgentCard, b: AgentCard) -> Bool { a.agent == b.agent && a.selected == b.selected }

    private var provider: String? {
        let parts = [agent.providerName ?? agent.providerId, agent.accountLabel].compactMap { $0?.nonEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var edge: Color? {
        if selected { return Palette.lit }
        if agent.state == .needsYou { return Palette.amber.opacity(0.42) }
        if agent.state == .failed { return Palette.red.opacity(0.30) }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StateChip(state: agent.state)
                if let ws = agent.workspaceName?.nonEmpty {
                    Text(ws)
                        .font(.kcCaption)
                        .foregroundStyle(Palette.faint)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                AgentElapsed(agent: agent)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(agent.displayName)
                    .font(.kcHeadline)
                    .foregroundStyle(Palette.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if let provider {
                    Text(provider)
                        .font(.kcFootnote)
                        .foregroundStyle(Palette.text2)
                        .lineLimit(1)
                }
            }

            if agent.model != nil || agent.effort != nil {
                HStack(spacing: 6) {
                    if let model = agent.model?.nonEmpty { MonoChip(text: model) }
                    if let effort = agent.effort?.nonEmpty { MonoChip(text: effort) }
                }
            }

            if let branch = agent.branch?.nonEmpty {
                HStack(spacing: 8) {
                    MetaItem(symbol: "arrow.triangle.branch", text: branch, tone: Palette.text2, mono: true)
                    if agent.worktree == true {
                        Tag(text: "worktree", tone: .accent, symbol: "square.stack.3d.up.fill")
                    }
                }
            }

            if let error = agent.error?.nonEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.circle.fill").font(.system(size: 11, weight: .semibold))
                    Text(error).font(.kcFootnote).lineLimit(2)
                }
                .foregroundStyle(Palette.redText)
            } else if let activity = agent.activity?.nonEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "chevron.right.2").font(.system(size: 9, weight: .bold))
                        .foregroundStyle(agent.state.tone.fill.opacity(0.9))
                    Text(activity).font(.kcFootnote).foregroundStyle(Palette.text2).lineLimit(2)
                }
            }

            let files = agent.filesChanged ?? 0
            let approvals = agent.pendingApprovals ?? 0
            if files > 0 || approvals > 0 {
                Hairline().padding(.top, 2)
                HStack(spacing: 14) {
                    if files > 0 {
                        MetaItem(symbol: "doc.on.doc", text: Plural.s(files, "file") + " changed", tone: Palette.muted)
                    }
                    if approvals > 0 {
                        MetaItem(symbol: "hand.raised.fill", text: Plural.s(approvals, "approval"), tone: Palette.amberText)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 14, edge: edge)
        .overlay(alignment: .leading) {
            if agent.state == .needsYou || agent.state == .failed {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(agent.state.tone.fill)
                    .frame(width: 3)
                    .padding(.vertical, 16)
                    .offset(x: -0.5)
            }
        }
    }

    var accessibilitySummary: String {
        var parts = [agent.displayName, agent.state.label]
        if let provider { parts.append(provider) }
        if let model = agent.model { parts.append("model \(model)" + (agent.effort.map { ", \($0) effort" } ?? "")) }
        if let branch = agent.branch { parts.append("branch \(branch)" + (agent.worktree == true ? " in a worktree" : "")) }
        if let error = agent.error { parts.append("error: \(error)") } else if let a = agent.activity { parts.append(a) }
        if let f = agent.filesChanged, f > 0 { parts.append(Plural.s(f, "file") + " changed") }
        if let p = agent.pendingApprovals, p > 0 { parts.append(Plural.s(p, "approval") + " waiting") }
        return parts.joined(separator: ", ")
    }
}

/// Subtle press feedback for tappable cards.
struct CardPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .brightness(configuration.isPressed ? 0.03 : 0)
            .animation(Motion.quick, value: configuration.isPressed)
    }
}

// MARK: - Needs You card

extension NeedsYouKind {
    var label: String {
        switch self {
        case .approval: return "Approval"
        case .question: return "Question"
        case .failed: return "Failed"
        case .auth: return "Sign-in needed"
        case .stalled: return "Stalled"
        case .review: return "Review"
        case .unknown: return "Needs you"
        }
    }

    var symbol: String {
        switch self {
        case .approval: return "checkmark.shield.fill"
        case .question: return "questionmark.bubble.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .auth: return "key.fill"
        case .stalled: return "pause.circle.fill"
        case .review: return "eye.fill"
        case .unknown: return "hand.raised.fill"
        }
    }

    var tone: Tone { self == .failed ? .red : .amber }
}

struct NeedsYouCard: View {
    @Environment(AppModel.self) private var model
    let item: NeedsYouItem
    var selected = false
    var compact = false
    var onOpen: () -> Void
    @State private var deciding: Bool? = nil

    private var agentName: String? {
        item.agentId.flatMap { model.client.fleet.agent($0)?.displayName }
    }

    var body: some View {
        let live = model.client.status.isOnline
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: item.kind.symbol)
                    .font(.system(size: 11, weight: .bold))
                Text(item.kind.label.uppercased())
                    .font(.kcLabel)
                    .tracking(0.9)
                Spacer(minLength: 4)
                RelativeLabel(date: item.createdAt, font: .kcCaption)
                if !actionable && item.agentId != nil {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Palette.faint)
                }
            }
            .foregroundStyle(item.kind.tone.text)

            VStack(alignment: .leading, spacing: 4) {
                Text(item.title?.nonEmpty ?? item.kind.label)
                    .font(.kcSubMedium)
                    .foregroundStyle(Palette.text)
                    .lineLimit(compact ? 2 : 3)
                if let detail = item.detail?.nonEmpty {
                    Text(detail)
                        .font(.kcFootnote)
                        .foregroundStyle(Palette.text2)
                        .lineLimit(compact ? 1 : 3)
                }
                if let agentName, !(compact && item.title?.contains(agentName) == true) {
                    MetaItem(symbol: "cpu", text: agentName, tone: Palette.muted)
                        .padding(.top, 2)
                }
            }

            if actionable {
            HStack(spacing: 8) {
                if item.canApprove {
                    Button {
                        decide(true)
                    } label: {
                        if deciding == true { ProgressView().controlSize(.small).tint(.white) } else { Text("Approve once") }
                    }
                    .buttonStyle(PrimaryButtonStyle(compact: true))
                    .accessibilityIdentifier("needs.approve.\(item.id)")
                }
                if item.canDeny {
                    Button {
                        decide(false)
                    } label: {
                        if deciding == false { ProgressView().controlSize(.small) } else { Text("Deny") }
                    }
                    .buttonStyle(SecondaryButtonStyle(compact: true))
                    .accessibilityIdentifier("needs.deny.\(item.id)")
                }
            }
            .disabled(!live || deciding != nil)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 14, edge: selected ? Palette.lit : item.kind.tone.fill.opacity(0.34),
              fill: Palette.surface1)
        .overlay {
            RoundedRectangle(cornerRadius: Metrics.radius, style: .continuous)
                .fill(LinearGradient(colors: [item.kind.tone.fill.opacity(0.07), .clear], startPoint: .topLeading, endPoint: .center))
                .allowsHitTesting(false)
        }
        .contentShape(Rectangle())
        .onTapGesture { if item.agentId != nil { onOpen() } }
        .accessibilityElement(children: .contain)
        .accessibilityAction(named: "Open agent") { if item.agentId != nil { onOpen() } }
        .accessibilityLabel([item.kind.label, item.title, item.detail, agentName.map { "from \($0)" }].compactMap { $0 }.joined(separator: ", "))
        .accessibilityIdentifier("needsCard.\(item.id)")
    }

    private var actionable: Bool { item.canApprove || item.canDeny }

    private func decide(_ approve: Bool) {
        deciding = approve
        Task {
            await model.decide(item, approve: approve)
            deciding = nil
        }
    }
}
