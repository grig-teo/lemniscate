import SwiftUI

struct MainView: View {
    @EnvironmentObject private var session: SessionStore
    @StateObject private var viewModel = MainViewModel()

    var body: some View {
        ZStack {
            GlassBackground()
            VStack(spacing: 24) {
                topBar
                Spacer()
                micButton
                selectedRepoLabel
                transcriptCard
                Spacer()
            }
            .padding()
        }
        .sheet(isPresented: $viewModel.showRepoPicker) {
            RepoPickerView(selected: $viewModel.selectedRepo)
        }
        .sheet(isPresented: $viewModel.showSettings) {
            SettingsView()
        }
        .errorAlert($viewModel.alertMessage)
    }

    private var topBar: some View {
        HStack {
            Button { viewModel.showRepoPicker = true } label: {
                Label(
                    viewModel.selectedRepo?.name ?? "Select repository",
                    systemImage: "folder.badge.plus"
                )
                .lineLimit(1)
            }
            .buttonStyle(GlassCapsuleButtonStyle())
            Spacer()
            Button { viewModel.showSettings = true } label: {
                Image(systemName: "gearshape.fill")
            }
            .buttonStyle(GlassCapsuleButtonStyle())
        }
    }

    private var micButton: some View {
        Button {
            Task { await viewModel.toggleMic() }
        } label: {
            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)
                    .overlay(Circle().stroke(.white.opacity(0.35), lineWidth: 1))
                if viewModel.isSending {
                    ProgressView()
                        .controlSize(.large)
                        .tint(.white)
                } else {
                    Image(systemName: viewModel.isRecording ? "stop.fill" : "mic.fill")
                        .font(.system(size: 54, weight: .medium))
                        .foregroundStyle(viewModel.isRecording ? Color.red : Color.white)
                }
            }
            .frame(width: 150, height: 150)
            .shadow(color: .black.opacity(0.25), radius: 12, y: 6)
        }
        .disabled(!viewModel.micEnabled)
        .opacity(viewModel.micEnabled ? 1 : 0.35)
        .animation(.easeInOut(duration: 0.2), value: viewModel.micEnabled)
    }

    private var selectedRepoLabel: some View {
        Text(labelText)
            .font(.subheadline)
            .foregroundStyle(.white.opacity(0.75))
            .multilineTextAlignment(.center)
    }

    private var labelText: String {
        if let repo = viewModel.selectedRepo {
            return repo.fullName
        }
        return "Select a repository to enable the microphone"
    }

    @ViewBuilder
    private var transcriptCard: some View {
        if viewModel.isRecording || !viewModel.transcript.isEmpty {
            Text(viewModel.transcript.isEmpty ? "Listening…" : viewModel.transcript)
                .font(.body)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard()
        }
    }
}
