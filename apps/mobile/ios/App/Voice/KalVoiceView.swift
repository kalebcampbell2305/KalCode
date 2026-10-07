import SwiftUI
import RemoteKit

/// One KalVoice command in this session.
struct VoiceEntry: Identifiable, Equatable {
    enum State: Equatable {
        case sending
        case finished(summary: String?, outcome: String?)
        case failed(String)
    }
    let id = UUID()
    let text: String
    let at = Date()
    var state: State
}

/// Outcome styling for `voice.command` (protocol §8: done | partial | refused | clarify).
private enum VoiceOutcome {
    case done, partial, refused, clarify

    init(_ raw: String?) {
        switch raw?.lowercased() {
        case "partial": self = .partial
        case "refused": self = .refused
        case "clarify": self = .clarify
        default: self = .done
        }
    }

    var title: String {
        switch self {
        case .done: return "Done"
        case .partial: return "Partly done"
        case .refused: return "KalVoice declined"
        case .clarify: return "KalVoice needs more detail"
        }
    }

    var tone: Tone {
        switch self {
        case .done: return .green
        case .partial: return .amber
        case .refused: return .red
        case .clarify: return .blue
        }
    }

    var symbol: String {
        switch self {
        case .done: return "checkmark.circle.fill"
        case .partial: return "exclamationmark.circle.fill"
        case .refused: return "hand.raised.slash.fill"
        case .clarify: return "questionmark.circle.fill"
        }
    }
}

struct KalVoiceView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isSplitPane) private var isSplitPane
    @State private var capture = VoiceCapture()
    @State private var entries: [VoiceEntry] = []
    @State private var typed = ""
    @State private var breathe = false
    @State private var viewportHeight: CGFloat = 0
    @FocusState private var fieldFocused: Bool

    var body: some View {
        let status = model.client.status
        let canSend = status.isOnline || status.isReconnecting
        ScrollViewReader { proxy in
        ScrollView {
            VStack(spacing: 22) {
                ConnectionBanner()
                    .frame(maxWidth: 560)

                globe
                    .padding(.top, 6)

                VStack(spacing: 8) {
                    Text(headline)
                        .font(.kcTitle2)
                        .foregroundStyle(Palette.text)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("voice.headline")
                    if !capture.transcript.isEmpty {
                        Text("“\(capture.transcript)”")
                            .font(.kcBodyLight)
                            .foregroundStyle(Palette.text2)
                            .multilineTextAlignment(.center)
                            .transition(.opacity)
                            .accessibilityIdentifier("voice.transcript")
                    } else {
                        Text(subline)
                            .font(.kcSub)
                            .foregroundStyle(Palette.muted)
                            .multilineTextAlignment(.center)
                    }
                }
                .frame(maxWidth: 520)
                .animation(Motion.gentle, value: capture.transcript)

                micButton(canSend: canSend)

                if case .unavailable(let message) = capture.phase {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "mic.slash.fill").foregroundStyle(Palette.muted)
                        Text(message).font(.kcFootnote).foregroundStyle(Palette.text2)
                        Spacer(minLength: 0)
                    }
                    .card(padding: 12, radius: 12)
                    .frame(maxWidth: 560)
                    .accessibilityIdentifier("voice.unavailable")
                }

                typedField(canSend: canSend)
                    .frame(maxWidth: 560)

                if let latest = entries.first {
                    ResultCard(entry: latest, queued: latest.state == .sending && status.isReconnecting)
                        .frame(maxWidth: 560)
                        .id("latest")
                        .accessibilityIdentifier("voice.result")
                }

                if entries.count > 1 {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeader(title: "This session", count: entries.count - 1)
                        ForEach(entries.dropFirst()) { HistoryRow(entry: $0) }
                    }
                    .frame(maxWidth: 560)
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity)
            .frame(minHeight: viewportHeight * 0.92, alignment: .center)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
        .onChange(of: entries.first?.state) { _, _ in
            withAnimation(Motion.standard(reduceMotion)) { proxy.scrollTo("latest", anchor: .center) }
        }
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollIndicators(.hidden)
        .spaceBackground(.cinematic, nebulaHeight: nil)
        .navigationTitle("KalVoice")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { capture.cancel() }
        .accessibilityIdentifier("voice.view")
    }

    private var headline: String {
        switch capture.phase {
        case .listening: return "Listening…"
        case .preparing: return "Getting ready…"
        default:
            if entries.first?.state == .sending { return "Working on it…" }
            return "What should your agents do?"
        }
    }

    private var subline: String {
        "Ask for status, steer an agent, approve, launch or tidy up — the same commands as KalVoice on \(model.workstationName)."
    }

    private var globe: some View {
        let listening = capture.isListening
        let pulse = listening && !reduceMotion
        return ZStack {
            Circle()
                .fill(RadialGradient(colors: [Palette.accent.opacity(listening ? 0.42 : 0.22), .clear], center: .center, startRadius: 10, endRadius: entries.isEmpty ? 170 : 120))
                .frame(width: entries.isEmpty ? 340 : 240, height: entries.isEmpty ? 340 : 240)
                .opacity(listening ? 0.7 + capture.level * 0.3 : 0.8)
            Image("KalVoiceGlobe")
                .resizable()
                .interpolation(.high)
                .scaledToFit()
                .frame(width: entries.isEmpty ? 210 : 150, height: entries.isEmpty ? 210 : 150)
                .scaleEffect(pulse ? (breathe ? 1.05 : 0.98) + capture.level * 0.05 : 1)
                .opacity(listening || reduceMotion ? 1 : 0.92)
        }
        .frame(height: entries.isEmpty ? 250 : 180)
        .animation(pulse ? .easeInOut(duration: 1.3).repeatForever(autoreverses: true) : .easeOut(duration: 0.2), value: breathe)
        .onChange(of: listening) { _, now in breathe = now }
        .accessibilityHidden(true)
    }

    private func micButton(canSend: Bool) -> some View {
        let listening = capture.isListening
        return Button {
            Task { await toggleListening() }
        } label: {
            ZStack {
                Circle()
                    .fill(LinearGradient(colors: listening ? [Palette.red, Color(hex: 0xC94350)] : [Palette.primaryTop, Palette.primaryBottom],
                                         startPoint: .top, endPoint: .bottom))
                Circle().strokeBorder(.white.opacity(0.18), lineWidth: 0.75)
                if capture.phase == .preparing {
                    ProgressView().tint(.white)
                } else {
                    Image(systemName: listening ? "stop.fill" : "mic.fill")
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundStyle(.white)
                        .contentTransition(.symbolEffect(.replace))
                }
            }
            .frame(width: 80, height: 80)
            .shadow(color: (listening ? Palette.red : Palette.accent).opacity(0.45), radius: 18, y: 6)
            .overlay {
                Circle()
                    .strokeBorder((listening ? Palette.red : Palette.accent).opacity(0.35), lineWidth: 1)
                    .frame(width: 100, height: 100)
            }
            .frame(width: 104, height: 104)
        }
        .buttonStyle(CardPressStyle())
        .disabled(!canSend && !listening)
        .accessibilityLabel(listening ? "Stop and send" : "Speak a command")
        .accessibilityIdentifier("voice.mic")
    }

    private func typedField(canSend: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "keyboard")
                .font(.system(size: 14))
                .foregroundStyle(Palette.faint)
            TextField("Or type a command…", text: $typed, axis: .vertical)
                .font(.kcCallout)
                .foregroundStyle(Palette.text)
                .lineLimit(1...4)
                .focused($fieldFocused)
                .submitLabel(.send)
                .onSubmit { sendTyped() }
                .accessibilityIdentifier("voice.field")
            Button(action: sendTyped) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(typed.nonEmpty == nil ? Palette.faint : .white)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(typed.nonEmpty == nil
                                              ? AnyShapeStyle(Palette.surface3)
                                              : AnyShapeStyle(LinearGradient(colors: [Palette.primaryTop, Palette.primaryBottom], startPoint: .top, endPoint: .bottom))))
            }
            .buttonStyle(.plain)
            .disabled(typed.nonEmpty == nil || !canSend)
            .accessibilityLabel("Send command")
            .accessibilityIdentifier("voice.send")
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Palette.surface1.opacity(0.92)))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(fieldFocused ? Palette.lit : Palette.border, lineWidth: 0.75))
    }

    // MARK: Actions

    private func toggleListening() async {
        if capture.isListening {
            Haptics.tap()
            let text = await capture.stop()
            if let text = text.nonEmpty { send(text) }
        } else {
            capture.resetAvailability()
            Haptics.tap()
            await capture.start()
            if case .unavailable = capture.phase { Haptics.warning() }
        }
    }

    private func sendTyped() {
        guard let text = typed.nonEmpty else { return }
        typed = ""
        fieldFocused = false
        send(text)
    }

    private func send(_ text: String) {
        let entry = VoiceEntry(text: text, state: .sending)
        withAnimation(Motion.standard(reduceMotion)) { entries.insert(entry, at: 0) }
        Task {
            let state: VoiceEntry.State
            do {
                let r: SummaryResult = try await model.call("voice.command", ["text": .string(text)])
                state = .finished(summary: r.summary, outcome: r.outcome)
                switch VoiceOutcome(r.outcome) {
                case .done: Haptics.success()
                case .partial, .clarify: Haptics.warning()
                case .refused: Haptics.error()
                }
            } catch {
                state = .failed(model.errorText(error))
                Haptics.error()
            }
            if let i = entries.firstIndex(where: { $0.id == entry.id }) {
                withAnimation(Motion.gentle) { entries[i].state = state }
            }
        }
    }
}

private struct ResultCard: View {
    let entry: VoiceEntry
    let queued: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "quote.opening").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.faint)
                Text(entry.text).font(.kcSub).foregroundStyle(Palette.text2)
            }
            Hairline()
            switch entry.state {
            case .sending:
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small).tint(queued ? Palette.amber : Palette.accentText)
                    Text(queued ? "Queued — sends when connected" : "Sending to KalVoice…")
                        .font(.kcSubMedium)
                        .foregroundStyle(queued ? Palette.amberText : Palette.accentText)
                }
                .accessibilityIdentifier(queued ? "voice.queued" : "voice.sending")
            case let .finished(summary, outcome):
                let o = VoiceOutcome(outcome)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 7) {
                        Image(systemName: o.symbol).font(.system(size: 14, weight: .semibold))
                        Text(o.title).font(.kcSubMedium)
                    }
                    .foregroundStyle(o.tone.text)
                    if let summary = summary?.nonEmpty {
                        Text(summary).font(.kcCallout).foregroundStyle(Palette.text).fixedSize(horizontal: false, vertical: true)
                    }
                    if o == .clarify {
                        Text("Try again with the agent's name or a little more detail.")
                            .font(.kcFootnote)
                            .foregroundStyle(Palette.muted)
                    }
                }
            case .failed(let message):
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "xmark.octagon.fill").foregroundStyle(Palette.red)
                    Text(message).font(.kcSub).foregroundStyle(Palette.text)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(padding: 16, edge: edge)
        .accessibilityElement(children: .combine)
    }

    private var edge: Color {
        switch entry.state {
        case .sending: return queued ? Palette.amber.opacity(0.3) : Palette.litSoft
        case .finished(_, let outcome): return VoiceOutcome(outcome).tone.edge
        case .failed: return Palette.red.opacity(0.3)
        }
    }
}

private struct HistoryRow: View {
    let entry: VoiceEntry

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol.0)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(symbol.1)
                .frame(width: 16)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.text).font(.kcSubMedium).foregroundStyle(Palette.text).lineLimit(2)
                if let detail { Text(detail).font(.kcFootnote).foregroundStyle(Palette.muted).lineLimit(2) }
            }
            Spacer(minLength: 0)
            Text(entry.at, style: .time).font(.kcCaption).foregroundStyle(Palette.faint)
        }
        .card(padding: 12, radius: 12)
        .accessibilityElement(children: .combine)
    }

    private var symbol: (String, Color) {
        switch entry.state {
        case .sending: return ("clock", Palette.muted)
        case .finished(_, let o): let v = VoiceOutcome(o); return (v.symbol, v.tone.fill)
        case .failed: return ("xmark.octagon.fill", Palette.red)
        }
    }

    private var detail: String? {
        switch entry.state {
        case .sending: return nil
        case .finished(let s, _): return s
        case .failed(let m): return m
        }
    }
}
