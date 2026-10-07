import SwiftUI
import RemoteKit

/// Pinned prompt composer (rides the keyboard via safeAreaInset). Prompts may wait in the
/// offline queue while Reconnecting; they show as "Queued — sends when connected".
struct PromptComposer: View {
    let agent: Agent
    @Environment(AppModel.self) private var model
    @State private var draft = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    var body: some View {
        let status = model.client.status
        let canSend = status.isOnline || status.isReconnecting
        let queued = model.client.queue.items.filter { $0.op == "agent.prompt" && $0.agentId == agent.id }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)

        VStack(spacing: 8) {
            ForEach(queued) { item in
                HStack(spacing: 8) {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Palette.amber)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Queued — sends when connected")
                            .font(.kcCaption)
                            .foregroundStyle(Palette.amberText)
                        if let t = item.text {
                            Text(t).font(.kcFootnote).foregroundStyle(Palette.text2).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.amber.opacity(0.08)))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.amber.opacity(0.25), lineWidth: 0.75))
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("agent.prompt.queued")
                .transition(.opacity)
            }

            HStack(alignment: .bottom, spacing: 10) {
                TextField(canSend ? "Message \(agent.displayName)…" : "Not connected", text: $draft, axis: .vertical)
                    .font(.kcBody)
                    .foregroundStyle(Palette.text)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Palette.surface2))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .strokeBorder(focused ? Palette.lit : Palette.border, lineWidth: focused ? 1 : 0.75))
                    .disabled(!canSend)
                    .submitLabel(.send)
                    .accessibilityLabel("Prompt for \(agent.displayName)")
                    .accessibilityIdentifier("agent.prompt.field")

                Button(action: send) {
                    ZStack {
                        Circle()
                            .fill(text.isEmpty || !canSend
                                  ? AnyShapeStyle(Palette.surface3)
                                  : AnyShapeStyle(LinearGradient(colors: [Palette.primaryTop, Palette.primaryBottom], startPoint: .top, endPoint: .bottom)))
                        if sending {
                            ProgressView().controlSize(.small).tint(.white)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundStyle(text.isEmpty || !canSend ? Palette.faint : .white)
                        }
                    }
                    .frame(width: 42, height: 42)
                    .shadow(color: Palette.accent.opacity(text.isEmpty ? 0 : 0.35), radius: 8, y: 3)
                }
                .buttonStyle(.plain)
                .disabled(text.isEmpty || !canSend || sending)
                .accessibilityLabel("Send prompt")
                .accessibilityIdentifier("agent.prompt.send")
            }
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .frame(maxWidth: Metrics.readable)
        .frame(maxWidth: .infinity)
        .background {
            ZStack(alignment: .top) {
                Rectangle().fill(.ultraThinMaterial)
                Palette.bg.opacity(0.78)
                Hairline()
            }
            .ignoresSafeArea()
        }
        .animation(Motion.gentle, value: queued.count)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        Haptics.tap()
        draft = ""
        sending = model.client.status.isOnline
        let agentId = agent.id
        Task {
            do {
                let r: SummaryResult = try await model.call("agent.prompt", ["agentId": .string(agentId), "text": .string(text)])
                Haptics.success()
                model.show(r.summary?.nonEmpty ?? "Sent", style: .success)
            } catch {
                Haptics.error()
                if draft.isEmpty { draft = text }  // never lose what the person typed
                model.show(model.errorText(error, target: .agent), style: ErrorCopy.toastStyle(error))
            }
            sending = false
        }
    }
}
