import SwiftUI

/// Token entry form for GitVerse (also usable for GitHub/GitLab PATs).
/// The parent performs the actual connect request via `onSubmit`; thrown
/// errors are shown inline so the sheet stays open.
struct GitVerseTokenView: View {
    let onSubmit: (String, String?) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var token = ""
    @State private var baseUrl = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Personal access token") {
                    SecureField("Token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section("Server (optional)") {
                    TextField("https://gitverse.ru", text: $baseUrl)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Connect GitVerse")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") { submit() }
                        .disabled(!canSubmit)
                }
            }
        }
    }

    private var canSubmit: Bool {
        !token.trimmingCharacters(in: .whitespaces).isEmpty && !isSubmitting
    }

    private func submit() {
        isSubmitting = true
        errorMessage = nil
        let cleanToken = token.trimmingCharacters(in: .whitespaces)
        let cleanBase = baseUrl.trimmingCharacters(in: .whitespaces)
        Task {
            defer { isSubmitting = false }
            do {
                try await onSubmit(cleanToken, cleanBase.isEmpty ? nil : cleanBase)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
