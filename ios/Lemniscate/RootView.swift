import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: SessionStore

    var body: some View {
        Group {
            switch session.state {
            case .loading:
                loadingView
            case .loggedOut:
                AuthView()
            case .loggedIn:
                MainView()
            }
        }
        .task { await session.restore() }
    }

    private var loadingView: some View {
        ZStack {
            GlassBackground()
            ProgressView()
                .controlSize(.large)
                .tint(.white)
        }
    }
}
