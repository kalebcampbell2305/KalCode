import SwiftUI
import RemoteKit

/// Launch an agent on the workstation with an explicit workspace, provider, account, model and effort.
struct LaunchSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var options: LaunchOptions?
    @State private var loadError: String?
    @State private var workspaceId: String?
    @State private var providerId: String?
    @State private var accountId: String?
    @State private var modelId: String?
    @State private var effort: String?
    @State private var prompt = ""
    @State private var launching = false
    @State private var launchError: String?
    @FocusState private var promptFocused: Bool

    private var provider: LaunchOptions.Provider? { options?.providers.first { $0.id == providerId } }
    private var selectedModel: LaunchOptions.Model? { provider?.models?.first { $0.id == modelId } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let options {
                        form(options)
                    } else if let loadError {
                        InlineErrorCard(title: "Couldn't load launch options", message: loadError) { Task { await load() } }
                    } else {
                        LoadingRow(text: "Loading providers and models…")
                    }
                }
                .padding(Metrics.gutter)
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) {
                if options != nil {
                    VStack(spacing: 8) {
                        if let launchError {
                            Text(launchError)
                                .font(.kcFootnote)
                                .foregroundStyle(Palette.redText)
                                .multilineTextAlignment(.center)
                                .accessibilityIdentifier("launch.error")
                        }
                        Button(action: launch) {
                            HStack(spacing: 8) {
                                if launching { ProgressView().tint(.white).controlSize(.small) } else { Image(systemName: "paperplane.fill") }
                                Text(launching ? "Launching…" : "Launch agent")
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(!canLaunch)
                        .accessibilityIdentifier("launch.submit")
                    }
                    .padding(.horizontal, Metrics.gutter)
                    .padding(.vertical, 12)
                    .frame(maxWidth: 640)
                    .frame(maxWidth: .infinity)
                    .background(Palette.bg.opacity(0.92).ignoresSafeArea())
                }
            }
            .spaceBackground(.standard, nebulaHeight: 240)
            .navigationTitle("Launch an agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.accessibilityIdentifier("launch.cancel")
                }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Palette.bg)
        .task { if options == nil { await load() } }
    }

    private var canLaunch: Bool {
        workspaceId != nil && providerId != nil && !launching && model.client.status.isOnline
    }

    @ViewBuilder
    private func form(_ options: LaunchOptions) -> some View {
        field("Project") {
            PickerMenu(title: options.workspaces.first { $0.id == workspaceId }?.displayName ?? "Choose a project",
                       items: options.workspaces.map { ($0.id, $0.displayName) },
                       selection: $workspaceId)
                .accessibilityIdentifier("launch.workspace")
        }

        field("Provider") {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(options.providers) { p in
                        ChoiceChip(title: p.name ?? p.id, selected: p.id == providerId) {
                            selectProvider(p)
                        }
                    }
                }
            }
            .scrollClipDisabled()
            .accessibilityIdentifier("launch.provider")
        }

        if let accounts = provider?.accounts, !accounts.isEmpty {
            field("Account") {
                PickerMenu(title: accounts.first { $0.id == accountId }?.label ?? "Default account",
                           items: accounts.map { ($0.id, $0.label ?? $0.id) },
                           selection: $accountId)
                    .accessibilityIdentifier("launch.account")
            }
        }

        if let models = provider?.models, !models.isEmpty {
            field("Model") {
                PickerMenu(title: selectedModel.map { $0.name ?? $0.id } ?? "Provider default",
                           items: models.map { ($0.id, $0.name ?? $0.id) },
                           selection: $modelId)
                    .accessibilityIdentifier("launch.model")
            }
            .onChange(of: modelId) { _, _ in
                if !(selectedModel?.efforts ?? []).contains(effort ?? "") { effort = Self.defaultEffort(selectedModel?.efforts) }
            }
        }

        if let efforts = selectedModel?.efforts, !efforts.isEmpty {
            field("Effort") {
                HStack(spacing: 8) {
                    ForEach(efforts, id: \.self) { e in
                        ChoiceChip(title: e, selected: e == effort, mono: true) { effort = e }
                    }
                }
                .accessibilityIdentifier("launch.effort")
            }
        }

        field("Prompt", hint: "Optional — the agent starts on this right away.") {
            TextField("What should this agent do?", text: $prompt, axis: .vertical)
                .font(.kcBody)
                .foregroundStyle(Palette.text)
                .lineLimit(3...8)
                .focused($promptFocused)
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.surface2))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(promptFocused ? Palette.lit : Palette.border, lineWidth: 0.75))
                .accessibilityIdentifier("launch.prompt")
        }
    }

    private func field<Content: View>(_ title: String, hint: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title.uppercased()).font(.kcLabel).tracking(1).foregroundStyle(Palette.muted)
            content()
            if let hint { Text(hint).font(.kcCaption).foregroundStyle(Palette.faint) }
        }
    }

    private func selectProvider(_ p: LaunchOptions.Provider) {
        Haptics.select()
        providerId = p.id
        accountId = p.accounts?.first?.id
        modelId = p.models?.first?.id
        effort = Self.defaultEffort(p.models?.first?.efforts)
    }

    private static func defaultEffort(_ efforts: [String]?) -> String? {
        guard let efforts, !efforts.isEmpty else { return nil }
        return efforts.contains("medium") ? "medium" : efforts.first
    }

    private func load() async {
        do {
            let o: LaunchOptions = try await model.call("launch.options")
            options = o
            loadError = nil
            workspaceId = workspaceId ?? model.client.fleet.workstation?.activeWorkspaceId.flatMap { id in o.workspaces.first { $0.id == id }?.id } ?? o.workspaces.first?.id
            if providerId == nil, let first = o.providers.first { selectProvider(first) }
        } catch {
            loadError = model.errorText(error)
        }
    }

    private func launch() {
        guard let workspaceId, let providerId else { return }
        Haptics.tap()
        launching = true
        launchError = nil
        var args: [String: JSONValue] = ["workspaceId": .string(workspaceId), "providerId": .string(providerId)]
        if let accountId { args["accountId"] = .string(accountId) }
        if let modelId { args["model"] = .string(modelId) }
        if let effort { args["effort"] = .string(effort) }
        if let p = prompt.nonEmpty { args["prompt"] = .string(p) }
        Task {
            do {
                let r: SummaryResult = try await model.call("agent.launch", args)
                Haptics.success()
                dismiss()
                if let id = r.agentId {
                    // Wait briefly for the new agent's patch so we never open an empty target.
                    let deadline = Date().addingTimeInterval(5)
                    while model.client.fleet.agent(id) == nil && Date() < deadline {
                        try? await Task.sleep(nanoseconds: 150_000_000)
                    }
                    if model.client.fleet.agent(id) != nil { model.router.showAgent(id) }
                }
                model.show(r.summary?.nonEmpty ?? "Agent launched", style: .success)
            } catch {
                Haptics.error()
                launchError = model.errorText(error)
            }
            launching = false
        }
    }
}

private struct PickerMenu: View {
    var title: String
    var items: [(id: String, label: String)]
    @Binding var selection: String?
    var mono = false

    var body: some View {
        Menu {
            ForEach(items, id: \.id) { item in
                Button {
                    Haptics.select()
                    selection = item.id
                } label: {
                    if item.id == selection { Label(item.label, systemImage: "checkmark") } else { Text(item.label) }
                }
            }
        } label: {
            HStack {
                Text(title)
                    .font(mono ? .kcMono : .kcCallout)
                    .foregroundStyle(Palette.text)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.faint)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 13)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.surface2))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.border, lineWidth: 0.75))
        }
    }
}

struct ChoiceChip: View {
    var title: String
    var selected: Bool
    var mono = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(mono ? .kcMono : .kcSubMedium)
                .foregroundStyle(selected ? Palette.text : Palette.text2)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Capsule().fill(selected ? Palette.accent.opacity(0.18) : Palette.surface2))
                .overlay(Capsule().strokeBorder(selected ? Palette.lit : Palette.border, lineWidth: 0.75))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
