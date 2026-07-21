import SwiftUI

struct ConnectionsSettingsView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var viewModel = ConnectionsViewModel()

    var body: some View {
        List {
            connectionsSection
            addSection
            accountSection
        }
        .task { await viewModel.load() }
        .refreshable { await viewModel.load() }
        .sheet(item: $viewModel.sheet, content: sheetContent)
        .errorAlert($viewModel.errorMessage)
    }

    private var connectionsSection: some View {
        Section("Connected accounts") {
            if viewModel.connections.isEmpty && !viewModel.isLoading {
                Text("No connections yet")
                    .foregroundStyle(.secondary)
            }
            ForEach(viewModel.connections, content: connectionRow)
        }
    }

    private var addSection: some View {
        Section("Add connection") {
            Button("GitHub") { viewModel.sheet = .oauth(provider: "github") }
            Button("GitLab") { viewModel.sheet = .oauth(provider: "gitlab") }
            Button("GitVerse (token)") { viewModel.sheet = .gitverse }
        }
    }

    private var accountSection: some View {
        Section {
            Button("Sign out", role: .destructive) {
                session.logout()
            }
        }
    }

    private func connectionRow(_ connection: GitConnection) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(GitProvider.displayName(connection.provider))
                    .font(.headline)
                Text("@\(connection.username)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let baseUrl = connection.baseUrl {
                    Text(baseUrl)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let count = connection.count?.repositories {
                Text("\(count) repos")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Button {
                Task { await viewModel.sync(connection) }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
        }
        .swipeActions {
            Button(role: .destructive) {
                Task { await viewModel.delete(connection) }
            } label: {
                Label("Disconnect", systemImage: "trash")
            }
        }
    }

    @ViewBuilder
    private func sheetContent(_ sheet: ConnectionsViewModel.ConnectionSheet) -> some View {
        switch sheet {
        case .oauth(let provider):
            OAuthSheet(provider: provider) { token in
                Task {
                    await session.completeLogin(token: token)
                    viewModel.sheet = nil
                    await viewModel.load()
                }
            }
        case .gitverse:
            GitVerseTokenView { token, baseUrl in
                try await viewModel.connectGitVerse(token: token, baseUrl: baseUrl)
                await viewModel.load()
            }
        }
    }
}
