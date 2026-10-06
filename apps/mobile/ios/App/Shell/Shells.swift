import SwiftUI
import RemoteKit

// MARK: - iPhone (compact width): tabs

struct PhoneShell: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var router = model.router
        let needsCount = model.client.fleet.needsYou.count
        TabView(selection: $router.section) {
            Tab(AppSection.mission.title, systemImage: AppSection.mission.symbol, value: AppSection.mission) {
                NavigationStack(path: $router.missionPath) {
                    MissionControlView().routeDestinations()
                }
            }
            Tab(AppSection.needs.title, systemImage: AppSection.needs.symbol, value: AppSection.needs) {
                NavigationStack(path: $router.needsPath) {
                    NeedsYouView().routeDestinations()
                }
            }
            .badge(needsCount)
            Tab(AppSection.runs.title, systemImage: AppSection.runs.symbol, value: AppSection.runs) {
                NavigationStack(path: $router.runsPath) {
                    RunsView().routeDestinations()
                }
            }
            Tab(AppSection.voice.title, systemImage: AppSection.voice.symbol, value: AppSection.voice) {
                NavigationStack {
                    KalVoiceView()
                }
            }
        }
        .sheet(isPresented: $router.showLaunch) { LaunchSheet().environment(model) }
        .onAppear(perform: normalize)
        .onChange(of: router.section) { _, _ in normalize() }
    }

    /// Settings is a sidebar section on iPad; on iPhone it lives behind the Mission Control gear.
    private func normalize() {
        let router = model.router
        if router.section == .settings {
            router.section = .mission
            if router.missionPath.last != .settings { router.missionPath.append(.settings) }
        }
    }
}

// MARK: - iPad (regular width): sidebar + rich split detail

struct PadShell: View {
    @Environment(AppModel.self) private var model
    @State private var columns: NavigationSplitViewVisibility = .automatic

    var body: some View {
        @Bindable var router = model.router
        NavigationSplitView(columnVisibility: $columns) {
            Sidebar()
                .navigationSplitViewColumnWidth(min: 250, ideal: 280, max: 320)
        } detail: {
            NavigationStack {
                detail
                    .environment(\.isSplitPane, true)
                    .navigationTitle(model.router.section.title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        if model.router.section == .mission {
                            ToolbarItem(placement: .topBarTrailing) { LaunchToolbarButton() }
                        }
                    }
            }
        }
        .navigationSplitViewStyle(.automatic)
        .sheet(isPresented: $router.showLaunch) { LaunchSheet().environment(model) }
        .onChange(of: router.diffBeside) { _, beside in
            withAnimation(Motion.standard) { columns = beside ? .detailOnly : .automatic }
        }
        .onChange(of: router.missionPath) { _, path in
            // Keeps the pad in sync when a phone-style push happens (e.g. size class change).
            if path.last == .settings { router.section = .settings; router.missionPath.removeLast() }
        }
    }

    @ViewBuilder
    private var detail: some View {
        switch model.router.section {
        case .mission: PadMission()
        case .needs: PadNeeds()
        case .runs: PadRuns()
        case .voice: KalVoiceView()
        case .settings: SettingsView()
        }
    }
}

private struct PaneDivider: View {
    var body: some View { Hairline(vertical: true).ignoresSafeArea() }
}

private struct PadMission: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let router = model.router
        let selected = router.selectedAgentId
        let beside = router.diffBeside && selected != nil
        GeometryReader { geo in
            let listWidth = min(400, max(330, geo.size.width * 0.36))
            let agentWidth = min(460, max(380, geo.size.width * 0.38))
            HStack(spacing: 0) {
                if !beside {
                    MissionControlView()
                        .frame(width: selected == nil ? geo.size.width : listWidth)
                }
                if let id = selected {
                    PaneDivider()
                    AgentDetailView(agentId: id)
                        .id(id)
                        .frame(width: beside ? agentWidth : nil)
                        .frame(maxWidth: beside ? agentWidth : .infinity)
                    if beside {
                        PaneDivider()
                        DiffView(agentId: id)
                            .id("diff-\(id)")
                            .frame(maxWidth: .infinity)
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                    }
                }
            }
        }
        .animation(Motion.standard(reduceMotion), value: selected)
        .animation(Motion.standard(reduceMotion), value: beside)
    }
}

private struct PadNeeds: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 0) {
            NeedsYouView()
                .frame(width: 400)
            PaneDivider()
            Group {
                if let agentId = model.router.selectedNeedsAgentId {
                    AgentDetailView(agentId: agentId).id(agentId)
                } else {
                    PanePlaceholder(symbol: "hand.raised", title: "Pick something that needs you",
                                    message: "Approvals, questions and failures from your agents land here. Choose one to see its agent.")
                }
            }
            .frame(maxWidth: .infinity)
        }
    }
}

private struct PadRuns: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 0) {
            RunsView()
                .frame(width: 400)
            PaneDivider()
            Group {
                if let runId = model.router.selectedRunId {
                    RunDetailView(runId: runId).id(runId)
                } else {
                    PanePlaceholder(symbol: "terminal", title: "Pick a run",
                                    message: "Logs and test results from the workstation's runs open here.")
                }
            }
            .frame(maxWidth: .infinity)
        }
    }
}

struct PanePlaceholder: View {
    var symbol: String
    var title: String
    var message: String

    var body: some View {
        EmptyStateView(symbol: symbol, title: title, message: message)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .spaceBackground(.standard, nebulaHeight: 300)
    }
}

// MARK: - Sidebar

private struct Sidebar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let router = model.router
        let selection = Binding<AppSection?>(
            get: { router.section },
            set: { if let s = $0 { router.section = s; Haptics.select() } }
        )
        List(selection: selection) {
            Section {
                SidebarHeader()
                    .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 14, trailing: 4))
                    .listRowBackground(Color.clear)
                    .selectionDisabled()
            }
            Section {
                ForEach([AppSection.mission, .needs, .runs, .voice], id: \.self) { section in
                    row(section)
                }
            }
            Section {
                row(.settings)
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .background(Atmosphere(level: .standard, nebulaHeight: 260))
        .toolbar(.hidden, for: .navigationBar)
    }

    private func row(_ section: AppSection) -> some View {
        let count = section == .needs ? model.client.fleet.needsYou.count : 0
        return HStack(spacing: 12) {
            Image(systemName: section.symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(section == .needs && count > 0 ? Palette.amber : Palette.accentText)
                .frame(width: 22)
            Text(section.title)
                .font(.kcCallout)
                .foregroundStyle(Palette.text)
            Spacer(minLength: 0)
            if count > 0 {
                Text("\(count)")
                    .font(.kcMonoMedium)
                    .foregroundStyle(Palette.onAmber)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Palette.amber))
                    .accessibilityLabel("\(count) waiting")
            }
        }
        .padding(.vertical, 4)
        .tag(section)
        .accessibilityIdentifier("sidebar.\(section.rawValue)")
    }
}

private struct SidebarHeader: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image("KalCodeMark")
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 30, height: 30)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .shadow(color: Palette.accent.opacity(0.45), radius: 8)
                Text("KalCode Remote")
                    .font(.lexend(.semibold, 17, relativeTo: .headline))
                    .foregroundStyle(Palette.text)
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: PlatformGlyph.symbol(model.client.fleet.workstation?.platform ?? model.client.workstation?.host?.platform))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Palette.icy)
                    Text(model.workstationName)
                        .font(.kcSubMedium)
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                }
                StatusPill(status: model.client.status)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card(padding: 12, radius: 12)
        }
        .accessibilityElement(children: .combine)
    }
}
