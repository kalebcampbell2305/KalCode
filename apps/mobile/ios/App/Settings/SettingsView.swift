import SwiftUI
import UserNotifications
import RemoteKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Environment(\.isSplitPane) private var isSplitPane
    @State private var deviceName = ""
    @State private var notificationStatus: UNAuthorizationStatus = .notDetermined
    @State private var confirmUnpair = false
    @FocusState private var nameFocused: Bool

    var body: some View {
        let client = model.client
        let ws = client.workstation
        let fleetWs = client.fleet.workstation
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                group("Workstation") {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(spacing: 12) {
                            Image(systemName: PlatformGlyph.symbol(fleetWs?.platform ?? ws?.host?.platform))
                                .font(.system(size: 18, weight: .medium))
                                .foregroundStyle(Palette.icy)
                                .frame(width: 40, height: 40)
                                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.accent.opacity(0.12)))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.workstationName).font(.kcHeadline).foregroundStyle(Palette.text)
                                Text(PlatformGlyph.name(fleetWs?.platform ?? ws?.host?.platform)).font(.kcFootnote).foregroundStyle(Palette.muted)
                            }
                            Spacer(minLength: 0)
                            StatusPill(status: client.status)
                        }
                        Hairline()
                        let version = fleetWs?.version ?? ws?.host?.version
                        let build = fleetWs?.build ?? ws?.host?.build
                        InfoRow(label: "KalCode", value: version.map { v in "\(v)" + (build.map { " (\($0))" } ?? "") } ?? "—")
                        if let wid = ws?.wid ?? fleetWs?.id { InfoRow(label: "Workstation ID", value: wid, mono: true) }
                        if let device = ws?.deviceId { InfoRow(label: "This device ID", value: device, mono: true) }
                        if let paired = ws?.pairedAt {
                            InfoRow(label: "Paired", value: paired.formatted(date: .abbreviated, time: .shortened))
                        }
                        if let addrs = ws?.addrs, !addrs.isEmpty {
                            InfoRow(label: addrs.count == 1 ? "Address" : "Addresses", value: addrs.joined(separator: "\n"), mono: true)
                        }
                    }
                    .card()
                }

                group("This \(DeviceInfo.idiomNoun)", footer: "Your workstation shows this name in KalCode → Settings → Remote. A new name is sent the next time this device connects.") {
                    HStack(spacing: 10) {
                        Image(systemName: DeviceInfo.idiomNoun == "iPad" ? "ipad" : "iphone")
                            .foregroundStyle(Palette.accentText)
                        TextField("Device name", text: $deviceName)
                            .font(.kcCallout)
                            .foregroundStyle(Palette.text)
                            .focused($nameFocused)
                            .submitLabel(.done)
                            .onSubmit(saveName)
                            .textInputAutocapitalization(.words)
                            .onChange(of: deviceName) { _, v in if v.count > 64 { deviceName = String(v.prefix(64)) } }
                            .accessibilityIdentifier("settings.deviceName")
                        if nameFocused {
                            Button("Save", action: saveName)
                                .font(.kcSubMedium)
                                .foregroundStyle(Palette.accentText)
                        }
                    }
                    .card(padding: 14)
                }

                group("Notifications", footer: "KalCode notifies you only for decisions and outcomes — an agent needs you, failed or finished, a run failed, a deployment changed. Delivered while the app is connected.") {
                    HStack(spacing: 12) {
                        Image(systemName: notificationStatus == .authorized || notificationStatus == .provisional ? "bell.badge.fill" : "bell.slash.fill")
                            .foregroundStyle(notificationStatus == .authorized ? Palette.green : Palette.muted)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(notificationTitle).font(.kcSubMedium).foregroundStyle(Palette.text)
                        }
                        Spacer(minLength: 0)
                        switch notificationStatus {
                        case .notDetermined:
                            Button("Enable") {
                                Task {
                                    await Notifier.shared.requestAuthorization()
                                    await refreshNotifications()
                                }
                            }
                            .buttonStyle(PrimaryButtonStyle(compact: true, fullWidth: false))
                            .accessibilityIdentifier("settings.notifications.enable")
                        case .denied:
                            Button("Open Settings") {
                                if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                            }
                            .buttonStyle(SecondaryButtonStyle(compact: true, fullWidth: false))
                        default:
                            EmptyView()
                        }
                    }
                    .card(padding: 14)
                }

                group("Pairing", footer: "Unpairing forgets \(model.workstationName) and this device's key. To use Remote again, pair with a new code.") {
                    Button(role: .destructive) {
                        Haptics.warning()
                        confirmUnpair = true
                    } label: {
                        Label("Unpair this \(DeviceInfo.idiomNoun)", systemImage: "link.badge.plus")
                            .labelStyle(.titleOnly)
                    }
                    .buttonStyle(DestructiveButtonStyle())
                    .accessibilityIdentifier("settings.unpair")
                }

                about
            }
            .padding(Metrics.gutter)
            .padding(.bottom, 20)
            .frame(maxWidth: 680)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.bg.ignoresSafeArea())
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.large)
        .toolbar(isSplitPane ? .automatic : .hidden, for: .tabBar)
        .confirmationDialog("Unpair from \(model.workstationName)?", isPresented: $confirmUnpair, titleVisibility: .visible) {
            Button("Unpair", role: .destructive) {
                Haptics.success()
                model.unpair()
            }
            .accessibilityIdentifier("settings.unpair.confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This \(DeviceInfo.idiomNoun) stops seeing your agents right away.")
        }
        .task {
            deviceName = DeviceInfo.name
            await refreshNotifications()
        }
        .accessibilityIdentifier("settings.view")
    }

    private var about: some View {
        VStack(spacing: 10) {
            Image("KalCodeMark")
                .resizable()
                .interpolation(.high)
                .frame(width: 52, height: 52)
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                .shadow(color: Palette.accent.opacity(0.35), radius: 12)
            Text("KalCode Remote").font(.kcHeadline).foregroundStyle(Palette.text)
            Text("Version \(DeviceInfo.appVersion)").font(.kcMonoSmall).foregroundStyle(Palette.muted)
            Text("End-to-end encrypted with Noise IK. Your workstation is the only server.")
                .font(.kcFootnote).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
            Text("Fonts: Lexend Deca & JetBrains Mono — SIL OFL 1.1")
                .font(.kcCaption).foregroundStyle(Palette.faint)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 12)
        .accessibilityElement(children: .combine)
    }

    private var notificationTitle: String {
        switch notificationStatus {
        case .authorized, .provisional, .ephemeral: return "Notifications are on"
        case .denied: return "Notifications are off"
        default: return "Notifications aren't set up"
        }
    }

    private func refreshNotifications() async {
        notificationStatus = await Notifier.shared.authorizationStatus()
    }

    private func saveName() {
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty {
            UserDefaults.standard.removeObject(forKey: DeviceInfo.deviceNameKey)
            deviceName = DeviceInfo.name
        } else {
            UserDefaults.standard.set(String(name.prefix(64)), forKey: DeviceInfo.deviceNameKey)
        }
        nameFocused = false
        Haptics.success()
        model.show("Name saved — used next time this device connects", style: .success)
    }

    private func group<Content: View>(_ title: String, footer: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: title)
            content()
            if let footer {
                Text(footer).font(.kcFootnote).foregroundStyle(Palette.faint).padding(.horizontal, 4)
            }
        }
    }
}

private struct InfoRow: View {
    var label: String
    var value: String
    var mono = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).font(.kcSub).foregroundStyle(Palette.muted)
            Spacer(minLength: 12)
            Text(value)
                .font(mono ? .kcMonoSmall : .kcSub)
                .foregroundStyle(Palette.text2)
                .multilineTextAlignment(.trailing)
                .lineLimit(4)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}
