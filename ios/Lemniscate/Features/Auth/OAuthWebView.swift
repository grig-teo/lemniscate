import SwiftUI
import WebKit

/// Sheet hosting the OAuth flow in a WKWebView. When the flow redirects to
/// the frontend's /dashboard page, the session cookie is harvested from the
/// web view's cookie store and handed to the caller.
struct OAuthSheet: View {
    let provider: String
    let onToken: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            OAuthWebView(url: Endpoints.oauth(provider: provider), onToken: onToken)
                .ignoresSafeArea(.container, edges: .bottom)
                .navigationTitle("Sign in with \(GitProvider.displayName(provider))")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
        }
    }
}

struct OAuthWebView: UIViewRepresentable {
    let url: URL
    let onToken: (String) -> Void

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onToken: onToken)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private let onToken: (String) -> Void
        private var didHarvest = false

        init(onToken: @escaping (String) -> Void) {
            self.onToken = onToken
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard let url = webView.url, url.path.hasSuffix("/dashboard") else { return }
            harvestToken(from: webView)
        }

        private func harvestToken(from webView: WKWebView) {
            guard !didHarvest else { return }
            didHarvest = true
            let store = webView.configuration.websiteDataStore.httpCookieStore
            store.getAllCookies { cookies in
                guard let cookie = cookies.first(where: {
                    $0.name == SessionStore.cookieName
                }) else { return }
                Task { @MainActor in
                    self.onToken(cookie.value)
                }
            }
        }
    }
}
