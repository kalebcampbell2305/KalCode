import SwiftUI
import UIKit
import RemoteKit

struct PasteLinkSheet: View {
    var onValid: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Copy the pairing link from KalCode → Settings → Remote → Pair a device, then paste it here.")
                        .font(.kcSub)
                        .foregroundStyle(Palette.text2)

                    VStack(alignment: .leading, spacing: 8) {
                        TextField("kalcode-remote://pair?d=…", text: $text, axis: .vertical)
                            .font(.kcMono)
                            .foregroundStyle(Palette.text)
                            .lineLimit(3...6)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .focused($focused)
                            .padding(14)
                            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.codeBg))
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(error != nil ? Palette.red.opacity(0.55) : (focused ? Palette.lit : Palette.border), lineWidth: 0.75))
                            .onChange(of: text) { _, _ in error = nil }
                            .accessibilityLabel("Pairing link")
                            .accessibilityIdentifier("pair.linkField")

                        if let error {
                            HStack(alignment: .top, spacing: 6) {
                                Image(systemName: "exclamationmark.circle.fill")
                                Text(error)
                            }
                            .font(.kcFootnote)
                            .foregroundStyle(Palette.redText)
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("pair.linkError")
                        }
                    }

                    HStack(spacing: 10) {
                        Button {
                            if let s = UIPasteboard.general.string { text = s; validate() }
                        } label: {
                            Label("Paste", systemImage: "doc.on.clipboard")
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        .accessibilityIdentifier("pair.pasteFromClipboard")

                        Button(action: validate) {
                            Text("Continue")
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(text.nonEmpty == nil)
                        .accessibilityIdentifier("pair.continue")
                    }
                }
                .padding(20)
            }
            .background(Palette.bg.ignoresSafeArea())
            .navigationTitle("Paste pairing link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Palette.bg)
        .onAppear { focused = true }
    }

    private func validate() {
        do {
            _ = try PairingLink.parse(text)
            Haptics.success()
            onValid(text)
        } catch let e as PairingLinkError {
            Haptics.error()
            error = ErrorCopy.link(e)
        } catch {
            self.error = ErrorCopy.link(.malformed)
        }
    }
}
