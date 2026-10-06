import SwiftUI
import RemoteKit

struct NeedsYouView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.isSplitPane) private var isSplitPane

    var body: some View {
        let fleet = model.client.fleet
        let items = fleet.sortedNeedsYou.filter { $0.canApprove || $0.canDeny } + fleet.sortedNeedsYou.filter { !($0.canApprove || $0.canDeny) }
        let stale = !model.client.status.isOnline
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ConnectionBanner()
                VStack(alignment: .leading, spacing: 16) {
                if !fleet.hasSnapshot {
                    ForEach(0..<2, id: \.self) { _ in SkeletonCard() }
                } else if items.isEmpty {
                    EmptyStateView(symbol: "checkmark.seal", title: "Nothing needs you",
                                   message: "Approvals, questions and failures from your agents appear here the moment they happen.")
                        .card()
                } else {
                    let grouped = Dictionary(grouping: items, by: { $0.kind == .approval || $0.kind == .question ? 0 : 1 })
                    if let decisions = grouped[0], !decisions.isEmpty {
                        SectionHeader(title: "Decisions", count: decisions.count, tone: .amber)
                        cards(decisions)
                    }
                    if let other = grouped[1], !other.isEmpty {
                        SectionHeader(title: "Attention", count: other.count, tone: .amber)
                            .padding(.top, 6)
                        cards(other)
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
            guard !model.isSimulated else { return }
            model.client.reconnectNow()
            try? await Task.sleep(nanoseconds: 700_000_000)
        }
        .spaceBackground(.standard, nebulaHeight: 300)
        .navigationTitle("Needs You")
        .navigationBarTitleDisplayMode(isSplitPane ? .inline : .large)
        .accessibilityIdentifier("needs.list")
    }

    private func cards(_ items: [NeedsYouItem]) -> some View {
        LazyVStack(spacing: 12) {
            ForEach(items) { item in
                NeedsYouCard(item: item, selected: isSplitPane && model.router.selectedNeedsId == item.id) {
                    Haptics.tap()
                    model.router.showNeeds(item)
                }
            }
        }
    }
}
