import SwiftUI

struct RepoGroup: Identifiable {
    let id: String
    let provider: String
    let username: String
    let repos: [Repository]

    var title: String {
        let name = GitProvider.displayName(provider)
        return username.isEmpty ? name : "\(name) · @\(username)"
    }
}

struct TaskStatusBadge: View {
    let status: String

    var body: some View {
        Text(status)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.2), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case "running": return .green
        case "queued": return .orange
        case "failed": return .red
        default: return .gray
        }
    }
}

struct RepoPickerView: View {
    @Binding var selected: Repository?

    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel = RepoPickerViewModel()

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Repositories")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
                .task { await viewModel.load() }
                .errorAlert($viewModel.errorMessage)
        }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.groups.isEmpty {
            ProgressView()
        } else if viewModel.groups.isEmpty {
            ContentUnavailableView(
                "No repositories",
                systemImage: "tray",
                description: Text("Connect a git account in Settings.")
            )
        } else {
            repoList
        }
    }

    private var repoList: some View {
        List {
            ForEach(viewModel.groups) { group in
                Section(group.title) {
                    ForEach(group.repos, content: repoRow)
                }
            }
        }
        .refreshable { await viewModel.load() }
    }

    private func repoRow(_ repo: Repository) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                selectButton(repo)
                expandButton(repo)
            }
            if viewModel.expanded.contains(repo.id) {
                tasksView(repo)
            }
        }
        .padding(.vertical, 2)
    }

    private func selectButton(_ repo: Repository) -> some View {
        Button { select(repo) } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(repo.name)
                        .font(.headline)
                    Text(repo.fullName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let tasks = viewModel.runningTasks[repo.id], !tasks.isEmpty {
                    Text("\(tasks.count) running")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(.green.opacity(0.2), in: Capsule())
                        .foregroundStyle(.green)
                }
                if repo.id == selected?.id {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.tint)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func expandButton(_ repo: Repository) -> some View {
        Button {
            Task { await viewModel.toggleExpanded(repo) }
        } label: {
            Image(systemName: viewModel.expanded.contains(repo.id) ? "chevron.up" : "chevron.down")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func tasksView(_ repo: Repository) -> some View {
        if viewModel.loadingTasks.contains(repo.id) {
            ProgressView()
                .controlSize(.small)
        } else if let tasks = viewModel.runningTasks[repo.id], !tasks.isEmpty {
            ForEach(tasks) { task in
                HStack {
                    Text(task.title ?? task.prompt ?? "Task")
                        .font(.caption)
                        .lineLimit(1)
                    Spacer()
                    TaskStatusBadge(status: task.status)
                }
            }
        } else {
            Text("No running tasks")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func select(_ repo: Repository) {
        selected = repo
        dismiss()
    }
}
