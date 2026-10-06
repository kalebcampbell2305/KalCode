import SwiftUI
import RemoteKit

enum RunTone {
    static func tone(_ status: String?) -> Tone {
        switch status?.lowercased() {
        case "running", "in_progress", "deploying", "building", "starting": return .blue
        case "passed", "succeeded", "success", "done", "completed", "deployed", "healthy", "ok", "up": return .green
        case "failed", "error", "errored", "unhealthy", "down", "crashed": return .red
        case "queued", "pending", "waiting", "degraded", "warning": return .amber
        default: return .muted
        }
    }

    static func symbol(_ status: String?) -> String {
        switch tone(status) {
        case .blue: return "circle.dotted.circle"
        case .green: return "checkmark.circle.fill"
        case .red: return "xmark.octagon.fill"
        case .amber: return "clock.fill"
        default: return "circle"
        }
    }

    static func word(_ status: String?) -> String {
        (status?.replacingOccurrences(of: "_", with: " ").capitalized).flatMap { $0.nonEmpty } ?? "Unknown"
    }
}

struct RunsView: View {
    enum Segment: String, CaseIterable, Identifiable {
        case runs = "Runs", services = "Services", environments = "Environments"
        var id: String { rawValue }
    }

    @Environment(AppModel.self) private var model
    @Environment(\.isSplitPane) private var isSplitPane
    @State private var segment: Segment = .runs

    var body: some View {
        let fleet = model.client.fleet
        let stale = !model.client.status.isOnline
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ConnectionBanner()
                SegmentBar(segment: $segment, counts: [
                    .runs: fleet.runs.count, .services: fleet.services.count, .environments: fleet.environments.count,
                ])
                Group {
                    if !fleet.hasSnapshot {
                        ForEach(0..<2, id: \.self) { _ in SkeletonCard() }
                    } else {
                        switch segment {
                        case .runs: runs(fleet)
                        case .services: services(fleet)
                        case .environments: environments(fleet)
                        }
                    }
                }
                .staleDimmed(stale && fleet.hasSnapshot)
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 6)
            .padding(.bottom, 28)
            .frame(maxWidth: Metrics.readable)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .refreshable {
            guard !model.fixtureMode else { return }
            model.client.reconnectNow()
            try? await Task.sleep(nanoseconds: 700_000_000)
        }
        .spaceBackground(.standard, nebulaHeight: 300)
        .navigationTitle("Runs")
        .navigationBarTitleDisplayMode(isSplitPane ? .inline : .large)
        .accessibilityIdentifier("runs.list")
    }

    @ViewBuilder
    private func runs(_ fleet: FleetState) -> some View {
        let runs = fleet.runs.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
        if runs.isEmpty {
            EmptyStateView(symbol: "terminal", title: "No runs",
                           message: "Builds, tests and deploys started on \(model.workstationName) appear here.").card()
        } else {
            LazyVStack(spacing: 10) {
                ForEach(runs) { run in
                    Button {
                        Haptics.tap()
                        model.router.showRun(run.id)
                    } label: {
                        RunRow(run: run, selected: isSplitPane && model.router.selectedRunId == run.id)
                    }
                    .buttonStyle(CardPressStyle())
                    .accessibilityIdentifier("runRow.\(run.id)")
                }
            }
        }
    }

    @ViewBuilder
    private func services(_ fleet: FleetState) -> some View {
        if fleet.services.isEmpty {
            EmptyStateView(symbol: "server.rack", title: "No services", message: "Dev servers and background services started by KalCode appear here.").card()
        } else {
            VStack(spacing: 0) {
                ForEach(Array(fleet.services.enumerated()), id: \.element.id) { i, s in
                    if i > 0 { Hairline().padding(.leading, 34) }
                    ServiceRow(service: s)
                }
            }
            .card(padding: 0)
        }
    }

    @ViewBuilder
    private func environments(_ fleet: FleetState) -> some View {
        if fleet.environments.isEmpty {
            EmptyStateView(symbol: "globe", title: "No environments", message: "Deploy targets connected in KalCode appear here with their health.").card()
        } else {
            LazyVStack(spacing: 10) {
                ForEach(fleet.environments) { EnvironmentRow(env: $0) }
            }
        }
    }
}

private struct SegmentBar: View {
    @Binding var segment: RunsView.Segment
    var counts: [RunsView.Segment: Int]
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 4) {
            ForEach(RunsView.Segment.allCases) { s in
                let selected = s == segment
                Button {
                    Haptics.select()
                    withAnimation(Motion.standard) { segment = s }
                } label: {
                    HStack(spacing: 5) {
                        Text(s.rawValue).font(.kcSubMedium).lineLimit(1).minimumScaleFactor(0.8)
                        Text("\(counts[s] ?? 0)").font(.kcMonoSmall).foregroundStyle(selected ? Palette.icy : Palette.faint)
                    }
                    .foregroundStyle(selected ? Palette.text : Palette.text2)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background {
                        if selected {
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .fill(Palette.surface3)
                                .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Palette.litSoft, lineWidth: 0.75))
                                .matchedGeometryEffect(id: "seg", in: ns)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier("runs.segment.\(s.rawValue.lowercased())")
            }
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.surface1))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.border, lineWidth: 0.75))
    }
}

struct RunRow: View {
    let run: Run
    var selected = false

    var body: some View {
        let tone = RunTone.tone(run.status)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Tag(text: RunTone.word(run.status), tone: tone, symbol: RunTone.symbol(run.status))
                if let kind = run.kind?.nonEmpty { Tag(text: kind, tone: .muted) }
                Spacer(minLength: 0)
                RelativeLabel(date: run.updatedAt, font: .kcCaption)
            }
            Text(run.title?.nonEmpty ?? "Run")
                .font(.kcHeadline)
                .foregroundStyle(Palette.text)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            if let branch = run.branch?.nonEmpty {
                MetaItem(symbol: "arrow.triangle.branch", text: branch, tone: Palette.text2, mono: true)
            }
            if let action = run.currentAction?.nonEmpty {
                Text(action).font(.kcMonoSmall).foregroundStyle(Palette.text2).lineLimit(1).truncationMode(.middle)
            }
            if let outcome = run.outcome?.nonEmpty {
                Text(outcome).font(.kcFootnote).foregroundStyle(tone == .red ? Palette.redText : Palette.text2).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 14, edge: selected ? Palette.lit : (tone == .red ? Palette.red.opacity(0.3) : nil))
        .accessibilityElement(children: .combine)
    }
}

private struct ServiceRow: View {
    let service: Service

    var body: some View {
        let tone = RunTone.tone(service.status)
        HStack(spacing: 12) {
            Circle().fill(tone.fill).frame(width: 8, height: 8)
                .shadow(color: tone == .green ? tone.fill.opacity(0.7) : .clear, radius: 3)
                .frame(width: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text(service.name?.nonEmpty ?? service.id).font(.kcSubMedium).foregroundStyle(Palette.text)
                if let url = service.url?.nonEmpty {
                    Text(url).font(.kcMonoSmall).foregroundStyle(Palette.accentText).lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
            Text(RunTone.word(service.status)).font(.kcCaption).foregroundStyle(tone.text)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}

private struct EnvironmentRow: View {
    let env: DeployEnvironment

    var body: some View {
        let health = RunTone.tone(env.health)
        let deploy = RunTone.tone(env.deploymentStatus)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: env.kind?.lowercased() == "production" ? "globe.americas.fill" : "shippingbox.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.icy)
                Text(env.name?.nonEmpty ?? env.id).font(.kcHeadline).foregroundStyle(Palette.text)
                if let kind = env.kind?.nonEmpty { Tag(text: kind, tone: kind.lowercased() == "production" ? .accent : .muted) }
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                if env.health != nil { Tag(text: RunTone.word(env.health), tone: health, symbol: "heart.fill") }
                if env.deploymentStatus != nil { Tag(text: RunTone.word(env.deploymentStatus), tone: deploy, symbol: RunTone.symbol(env.deploymentStatus)) }
                Spacer(minLength: 0)
                if let at = env.lastDeployAt {
                    HStack(spacing: 4) {
                        Text("Deployed").font(.kcCaption).foregroundStyle(Palette.faint)
                        RelativeLabel(date: at, font: .kcCaption)
                    }
                }
            }
            if let url = env.url?.nonEmpty {
                Text(url).font(.kcMonoSmall).foregroundStyle(Palette.accentText).lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
            }
        }
        .card(padding: 14, edge: health == .red ? Palette.red.opacity(0.3) : nil)
        .accessibilityElement(children: .combine)
    }
}
