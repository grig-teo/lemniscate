import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var viewModel = AuthViewModel()

    var body: some View {
        ZStack {
            GlassBackground()
            VStack(spacing: 32) {
                Spacer()
                header
                Spacer()
                connectButtons
                Spacer()
                    .frame(height: 32)
            }
            .padding(24)
        }
        .sheet(item: $viewModel.sheet, content: sheetContent)
        .alert(
            "Sign in failed",
            isPresented: loginErrorBinding,
            actions: { Button("OK") {} },
            message: { Text(session.loginError ?? "Unknown error") }
        )
    }

    private var header: some View {
        VStack(spacing: 12) {
            Image(systemName: "infinity")
                .font(.system(size: 64, weight: .light))
                .foregroundStyle(.white)
            Text("Lemniscate")
                .font(.largeTitle.bold())
                .foregroundStyle(.white)
            Text("Speak. Agents code.")
                .foregroundStyle(.white.opacity(0.7))
        }
    }

    private var connectButtons: some View {
        VStack(spacing: 14) {
            oauthButton(title: "Continue with GitHub", provider: "github")
            oauthButton(title: "Continue with GitLab", provider: "gitlab")
            Button { viewModel.sheet = .gitverse } label: {
                Label("Connect GitVerse with token", systemImage: "key.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(GlassCapsuleButtonStyle())
        }
    }

    private func oauthButton(title: String, provider: String) -> some View {
        Button { viewModel.sheet = .oauth(provider: provider) } label: {
            Label(title, systemImage: "person.crop.circle.badge.plus")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(GlassCapsuleButtonStyle())
    }

    @ViewBuilder
    private func sheetContent(_ sheet: AuthViewModel.AuthSheet) -> some View {
        switch sheet {
        case .oauth(let provider):
            OAuthSheet(provider: provider) { token in
                Task {
                    await session.completeLogin(token: token)
                    viewModel.sheet = nil
                }
            }
        case .gitverse:
            GitVerseTokenView { token, baseUrl in
                try await viewModel.connectGitVerse(
                    token: token,
                    baseUrl: baseUrl,
                    session: session
                )
            }
        }
    }

    private var loginErrorBinding: Binding<Bool> {
        Binding(
            get: { session.loginError != nil },
            set: { if !$0 { session.clearLoginError() } }
        )
    }
}
