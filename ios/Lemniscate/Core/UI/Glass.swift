import SwiftUI

/// Glassmorphism building blocks shared by all screens.

struct GlassBackground: View {
    var body: some View {
        LinearGradient(
            colors: [
                Color(red: 0.16, green: 0.18, blue: 0.42),
                Color(red: 0.05, green: 0.06, blue: 0.16),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
    }
}

struct GlassCapsuleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial, in: Capsule())
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

extension View {
    func glassCard(cornerRadius: CGFloat = 20) -> some View {
        padding()
            .background(
                .ultraThinMaterial,
                in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            )
    }

    /// Presents `message` as an OK-only alert whenever it is non-nil.
    func errorAlert(_ message: Binding<String?>) -> some View {
        alert(
            "Lemniscate",
            isPresented: Binding(
                get: { message.wrappedValue != nil },
                set: { if !$0 { message.wrappedValue = nil } }
            ),
            actions: { Button("OK") {} },
            message: { Text(message.wrappedValue ?? "Unknown error") }
        )
    }
}
