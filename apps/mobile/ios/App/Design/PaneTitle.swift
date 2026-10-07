import SwiftUI

/// In iPad split panes, titles live in an in-pane header (one navigation bar per column would
/// merge toolbars); on iPhone the same title goes to the navigation bar.
struct PaneTitle<Trailing: View>: ViewModifier {
    var title: String
    var subtitle: String?
    @ViewBuilder var trailing: () -> Trailing
    @Environment(\.isSplitPane) private var isSplitPane

    func body(content: Content) -> some View {
        if isSplitPane {
            content.safeAreaInset(edge: .top, spacing: 0) {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title)
                            .font(.lexend(.semibold, 15, relativeTo: .headline))
                            .foregroundStyle(Palette.text)
                            .lineLimit(1)
                        if let subtitle {
                            Text(subtitle).font(.kcCaption).foregroundStyle(Palette.muted).lineLimit(1)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    trailing()
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.vertical, 8)
                .frame(minHeight: 52)
                .background {
                    ZStack(alignment: .bottom) {
                        Rectangle().fill(.ultraThinMaterial)
                        Palette.bg.opacity(0.75)
                        Hairline()
                    }
                }
            }
        } else {
            content
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) { NavTitle(title: title, subtitle: subtitle) }
                }
        }
    }
}

extension View {
    func paneTitle(_ title: String, subtitle: String? = nil) -> some View {
        modifier(PaneTitle(title: title, subtitle: subtitle) { EmptyView() })
    }

    func paneTitle<T: View>(_ title: String, subtitle: String? = nil, @ViewBuilder trailing: @escaping () -> T) -> some View {
        modifier(PaneTitle(title: title, subtitle: subtitle, trailing: trailing))
    }
}
