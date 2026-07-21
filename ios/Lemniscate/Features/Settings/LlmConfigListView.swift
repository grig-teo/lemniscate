import SwiftUI

struct LlmConfigListView: View {
    @StateObject private var viewModel = LlmConfigsViewModel()

    var body: some View {
        List {
            configsSection
            addSection
        }
        .task { await viewModel.load() }
        .refreshable { await viewModel.load() }
        .sheet(item: $viewModel.formTarget, content: formSheet)
        .errorAlert($viewModel.errorMessage)
    }

    private var configsSection: some View {
        Section("Saved configurations") {
            if viewModel.configs.isEmpty && !viewModel.isLoading {
                Text("No LLM configs yet")
                    .foregroundStyle(.secondary)
            }
            ForEach(viewModel.configs, content: configRow)
        }
    }

    private var addSection: some View {
        Section {
            Button {
                viewModel.formTarget = .add
            } label: {
                Label("Add LLM config", systemImage: "plus")
            }
        }
    }

    private func configRow(_ config: LlmConfig) -> some View {
        Button {
            viewModel.formTarget = .edit(config)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(config.name)
                        .font(.headline)
                    if config.isDefault == true {
                        badge("Default", color: .blue)
                    }
                    if config.enabled == false {
                        badge("Disabled", color: .gray)
                    }
                }
                Text("\(config.model) · \(config.baseUrl)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .swipeActions {
            Button(role: .destructive) {
                Task { await viewModel.delete(config) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.2), in: Capsule())
            .foregroundStyle(color)
    }

    @ViewBuilder
    private func formSheet(_ target: LlmConfigsViewModel.FormTarget) -> some View {
        switch target {
        case .add:
            LlmConfigFormView(mode: .add) {
                await viewModel.load()
            }
        case .edit(let config):
            LlmConfigFormView(mode: .edit(config)) {
                await viewModel.load()
            }
        }
    }
}
