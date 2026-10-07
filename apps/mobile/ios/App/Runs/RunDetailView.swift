import SwiftUI
import RemoteKit

struct RunDetailView: View {
    let runId: String
    @Environment(AppModel.self) private var model
    @Environment(\.isSplitPane) private var isSplitPane

    @State private var detail: RunDetail?
    @State private var loading = false
    @State private var error: String?

    private var run: Run? { model.client.fleet.run(runId) ?? detail?.run }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                ConnectionBanner()
                if let run {
                    RunRow(run: run).allowsHitTesting(false)
                        .staleDimmed(!model.client.status.isOnline)
                    content
                } else if model.client.fleet.hasSnapshot {
                    EmptyStateView(symbol: "flag.checkered", title: "This run has ended",
                                   message: "It's no longer tracked on \(model.workstationName).")
                }
            }
            .padding(Metrics.gutter)
            .frame(maxWidth: 980)
            .frame(maxWidth: .infinity)
        }
        .background(Palette.bg.ignoresSafeArea())
        .refreshable { await load() }
        .toolbar(.hidden, for: .tabBar)
        .paneTitle(run?.title ?? "Run", subtitle: run?.kind?.capitalized)
        .task(id: "\(run?.updatedAt?.timeIntervalSince1970 ?? 0)|\(model.client.status.isOnline)") { await load() }
        .onChange(of: model.client.fleet.run(runId) == nil) { _, missing in
            if missing && model.client.fleet.hasSnapshot && detail != nil {
                model.show("This run has ended", style: .info)
                model.router.runGone(runId)
            }
        }
        .accessibilityIdentifier("run.detail")
    }

    @ViewBuilder
    private var content: some View {
        if let detail {
            let tests = detail.testResults
            if !tests.isEmpty {
                let failed = tests.filter { RunTone.tone($0.status) == .red }.count
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(title: "Tests", count: tests.count, tone: failed > 0 ? .red : .green)
                    VStack(spacing: 0) {
                        ForEach(Array(tests.enumerated()), id: \.offset) { i, t in
                            if i > 0 { Hairline().padding(.leading, 38) }
                            TestRow(test: t)
                        }
                    }
                    .card(padding: 0)
                }
            }
            let logs = detail.logLines
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Log", count: logs.count)
                if logs.isEmpty {
                    Text("No log output.").font(.kcSub).foregroundStyle(Palette.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).card(padding: 14)
                } else {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(logs.suffix(600).enumerated()), id: \.offset) { _, line in
                            Text(line.isEmpty ? " " : line)
                                .font(.kcCode)
                                .foregroundStyle(lineColor(line))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Palette.codeBg))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 0.75))
                    .accessibilityIdentifier("run.log")
                }
            }
        } else if let error {
            InlineErrorCard(title: "Couldn't load this run", message: error) { Task { await load() } }
        } else if loading {
            LoadingRow(text: "Loading logs and tests…")
        } else if !model.client.status.isOnline {
            Text("Logs load when \(model.workstationName) is connected.")
                .font(.kcSub).foregroundStyle(Palette.muted)
                .frame(maxWidth: .infinity, alignment: .leading).card(padding: 14)
        }
    }

    private func lineColor(_ line: String) -> Color {
        let l = line.lowercased()
        if l.contains("error") || l.contains("failed") || l.contains("panic") { return Palette.redText }
        if l.contains("warn") { return Palette.amberText }
        if l.hasPrefix("$ ") || l.hasPrefix("> ") { return Palette.icy }
        return Palette.text2
    }

    private func load() async {
        guard model.client.status.isOnline else { return }
        loading = detail == nil
        defer { loading = false }
        do {
            let d: RunDetail = try await model.call("run.detail", ["runId": .string(runId)])
            detail = d
            error = nil
        } catch {
            if ErrorCopy.isNotFound(error) {
                model.show("This run has ended", style: .info)
                model.router.runGone(runId)
                return
            }
            if detail == nil { self.error = model.errorText(error, target: .run) }
        }
    }
}

private struct TestRow: View {
    let test: TestResult

    var body: some View {
        let tone = RunTone.tone(test.status)
        HStack(spacing: 10) {
            Image(systemName: RunTone.symbol(test.status))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tone.fill)
                .frame(width: 18)
            Text(test.name)
                .font(.kcMonoSmall)
                .foregroundStyle(Palette.text)
                .lineLimit(2)
                .truncationMode(.middle)
            Spacer(minLength: 8)
            if let ms = test.durationMs {
                Text(ms >= 1000 ? String(format: "%.1fs", Double(ms) / 1000) : "\(ms)ms")
                    .font(.kcMonoSmall)
                    .foregroundStyle(Palette.faint)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(test.name), \(test.status)" + (test.durationMs.map { ", \($0) milliseconds" } ?? ""))
    }
}
