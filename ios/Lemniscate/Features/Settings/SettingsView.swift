import SwiftUI

struct SettingsView: View {
    private enum Tab: String, CaseIterable, Identifiable {
        case connections = "Connections"
        case llm = "LLM Configs"

        var id: String { rawValue }
    }

    @State private var tab: Tab = .connections
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Section", selection: $tab) {
                    ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding()

                if tab == .connections {
                    ConnectionsSettingsView()
                } else {
                    LlmConfigListView()
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
