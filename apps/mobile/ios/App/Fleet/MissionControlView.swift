import SwiftUI
import RemoteKit

struct MissionControlView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.isSplitPane) private var isSplitPane
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var filter: FleetFilter = .all

    var body: some View {
        let client = model.client
        let fleet = client.fleet
        let stale = !client.status.isOnline
        let selected = isSplitPane ? model.router.selectedAgentId : nil
        let narrow = selected != nil

        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                ConnectionBanner()

                WorkstationHeader(filter: $filter)
                    .staleDimmed(stale && fleet.hasSnapshot)

                if !fleet.needsYou.isEmpty {
                    NeedsYouStrip(narrow: narrow)
                        .staleDimmed(stale)
                }

                if fleet.hasSnapshot {
                    if fleet.agents.isEmpty {
                        EmptyStateView(symbol: "sparkles", title: "No agents running",
                                       message: "Launch an agent here or on \(model.workstationName). It shows up live, with its state, model and branch.",
                                       image: "KalCodeMascot",
                                       action: ("Launch an agent", { model.router.showLaunch = true }))
                            .card()
                    } else {
                        fleetSection(fleet: fleet, selected: selected, narrow: narrow)
                            .staleDimmed(stale)
                    }
                } else {
                    VStack(spacing: 12) {
                        ForEach(0..<3, id: \.self) { _ in SkeletonCard() }
                    }
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.top, 6)
            .padding(.bottom, 28)
            .frame(maxWidth: narrow ? .infinity : 1180)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .refreshable {
            guard !model.fixtureMode else { return }
            client.reconnectNow()
            try? await Task.sleep(nanoseconds: 700_000_000)
        }
        .spaceBackground(.cinematic, nebulaHeight: 380)
        .navigationTitle("Mission Control")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !isSplitPane {
                ToolbarItem(placement: .topBarTrailing) {
                    LaunchToolbarButton()
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        model.router.missionPath.append(.settings)
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                    .accessibilityIdentifier("fleet.settings")
                }
            }
        }
        .accessibilityIdentifier("fleet.list")
    }

    @ViewBuilder
    private func fleetSection(fleet: FleetState, selected: String?, narrow: Bool) -> some View {
        let agents = fleet.sortedAgents(filter)
        VStack(alignment: .leading, spacing: 12) {
            FilterChips(filter: $filter, fleet: fleet)

            if agents.isEmpty {
                EmptyStateView(symbol: "line.3.horizontal.decrease.circle", title: "Nothing \(filter.title.lowercased()) right now",
                               message: "Agents appear here the moment their state changes.",
                               action: ("Show all", { withAnimation(Motion.quick) { filter = .all } }))
                    .card()
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: narrow ? 280 : 330), spacing: 12, alignment: .top)],
                          alignment: .leading, spacing: 12) {
                    ForEach(agents) { agent in
                        let card = AgentCard(agent: agent, selected: agent.id == selected)
                        Button {
                            Haptics.tap()
                            model.router.showAgent(agent.id)
                        } label: {
                            card.equatable()
                        }
                        .buttonStyle(CardPressStyle())
                        .accessibilityLabel(card.accessibilitySummary)
                        .accessibilityHint("Opens the agent")
                        .accessibilityIdentifier("agentCard.\(agent.id)")
                    }
                }
            }
        }
    }
}

// MARK: - Workstation header

struct WorkstationHeader: View {
    @Environment(AppModel.self) private var model
    @Binding var filter: FleetFilter

    var body: some View {
        let client = model.client
        let fleet = client.fleet
        let ws = fleet.workstation
        let platform = ws?.platform ?? client.workstation?.host?.platform
        let version = ws?.version ?? client.workstation?.host?.version
        let build = ws?.build ?? client.workstation?.host?.build

        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Text("WORKSTATION")
                    .font(.kcLabel)
                    .tracking(1.1)
                    .foregroundStyle(Palette.faint)
                Spacer(minLength: 0)
                StatusPill(status: client.status)
            }

            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(LinearGradient(colors: [Palette.accent.opacity(0.22), Palette.accent.opacity(0.06)], startPoint: .topLeading, endPoint: .bottomTrailing))
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Palette.litSoft, lineWidth: 0.75)
                    Image(systemName: PlatformGlyph.symbol(platform))
                        .font(.system(size: 19, weight: .medium))
                        .foregroundStyle(Palette.icy)
                }
                .frame(width: 46, height: 46)
                .shadow(color: Palette.accent.opacity(client.status.isOnline ? 0.35 : 0), radius: 12)

                VStack(alignment: .leading, spacing: 3) {
                    Text(model.workstationName)
                        .font(.kcTitle2)
                        .foregroundStyle(Palette.text)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)
                    Text(subtitle(platform: platform, version: version, build: build))
                        .font(.kcFootnote)
                        .foregroundStyle(Palette.muted)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
            }

            if let project = fleet.activeWorkspace {
                HStack(spacing: 8) {
                    Text("ACTIVE PROJECT")
                        .font(.kcLabel)
                        .tracking(1)
                        .foregroundStyle(Palette.faint)
                    Image(systemName: "folder.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(Palette.accentText)
                    Text(project.displayName)
                        .font(.kcSubMedium)
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
            }

            HStack(spacing: 10) {
                StatTile(value: fleet.count(.working), label: "Working", tone: .green, active: filter == .working) { toggle(.working) }
                StatTile(value: fleet.needsYou.count, label: "Needs You", tone: .amber, active: filter == .needsYou) { toggle(.needsYou) }
                StatTile(value: fleet.count(.failed), label: "Failed", tone: .red, active: filter == .failed) { toggle(.failed) }
            }
            .redacted(reason: fleet.hasSnapshot ? [] : .placeholder)
        }
        .padding(18)
        .background {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(LinearGradient(colors: [Palette.hull.opacity(0.92), Palette.surface1.opacity(0.88)], startPoint: .top, endPoint: .bottom))
        }
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(LinearGradient(colors: [Palette.litSoft, Palette.border], startPoint: .topTrailing, endPoint: .bottomLeading), lineWidth: 0.75)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("fleet.header")
    }

    private func subtitle(platform: String?, version: String?, build: Int?) -> String {
        var parts = [PlatformGlyph.name(platform)]
        if let version {
            parts.append("KalCode \(version)" + (build.map { " (\($0))" } ?? ""))
        }
        return parts.joined(separator: " · ")
    }

    private func toggle(_ f: FleetFilter) {
        Haptics.select()
        withAnimation(Motion.quick) { filter = (filter == f) ? .all : f }
    }
}

private struct StatTile: View {
    var value: Int
    var label: String
    var tone: Tone
    var active: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(value)")
                    .font(.kcStat)
                    .foregroundStyle(value > 0 ? tone.text : Palette.faint)
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text(label)
                    .font(.kcCaption)
                    .foregroundStyle(value > 0 ? Palette.text2 : Palette.faint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(active ? tone.wash : Palette.sunken.opacity(0.7)))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(active ? tone.edge : Palette.borderSubtle, lineWidth: 0.75))
            .overlay(alignment: .topTrailing) {
                if value > 0 {
                    Circle().fill(tone.fill).frame(width: 6, height: 6).padding(10)
                        .shadow(color: tone.fill.opacity(0.7), radius: 3)
                }
            }
        }
        .buttonStyle(CardPressStyle())
        .accessibilityLabel("\(value) \(label)")
        .accessibilityHint("Filters the fleet")
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

// MARK: - Filter chips

struct FilterChips: View {
    @Binding var filter: FleetFilter
    var fleet: FleetState

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(FleetFilter.allCases) { f in
                    let selected = f == filter
                    let count = f == .needsYou ? max(fleet.count(.needsYou), 0) : fleet.count(f)
                    Button {
                        Haptics.select()
                        withAnimation(Motion.quick) { filter = f }
                    } label: {
                        HStack(spacing: 6) {
                            Text(f.title).font(.kcSubMedium)
                            Text("\(count)")
                                .font(.kcMonoSmall)
                                .foregroundStyle(selected ? Palette.icy : Palette.faint)
                        }
                        .foregroundStyle(selected ? Palette.text : Palette.text2)
                        .padding(.horizontal, 13)
                        .padding(.vertical, 8)
                        .background(Capsule().fill(selected ? Palette.accent.opacity(0.18) : Palette.surface2))
                        .overlay(Capsule().strokeBorder(selected ? Palette.lit : Palette.border, lineWidth: 0.75))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(f.title), \(count)")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("filter.\(f.rawValue)")
                }
            }
            .padding(.vertical, 1)
        }
        .scrollClipDisabled()
    }
}

// MARK: - Needs You strip (top of Mission Control)

private struct NeedsYouStrip: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    var narrow: Bool

    var body: some View {
        // Decisions you can make right here come first, then the rest (oldest first within each).
        let all = model.client.fleet.sortedNeedsYou
        let items = all.filter { $0.canApprove || $0.canDeny } + all.filter { !($0.canApprove || $0.canDeny) }
        let shown = Array(items.prefix(narrow || sizeClass == .compact ? 2 : 3))
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Needs You", count: items.count, tone: .amber,
                          trailing: items.count > shown.count ? AnyView(
                            Button("See all") { model.router.section = .needs }
                                .font(.kcCaption)
                                .foregroundStyle(Palette.amberText)
                                .accessibilityIdentifier("needs.seeAll")
                          ) : nil)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: narrow ? 280 : 330), spacing: 12, alignment: .top)], spacing: 12) {
                ForEach(shown) { item in
                    NeedsYouCard(item: item, compact: true) {
                        if let agentId = item.agentId { model.router.showAgent(agentId) } else { model.router.showNeeds(item) }
                    }
                }
            }
        }
    }
}

struct LaunchToolbarButton: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Button {
            Haptics.tap()
            model.router.showLaunch = true
        } label: {
            Image(systemName: "plus")
        }
        .accessibilityLabel("Launch an agent")
        .accessibilityIdentifier("fleet.launch")
        .disabled(!model.client.status.isOnline)
    }
}
