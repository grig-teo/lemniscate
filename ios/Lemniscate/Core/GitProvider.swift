import Foundation

/// Display helpers for git hosting providers (github / gitlab / gitverse).
enum GitProvider {
    static func displayName(_ raw: String) -> String {
        switch raw.lowercased() {
        case "github": return "GitHub"
        case "gitlab": return "GitLab"
        case "gitverse": return "GitVerse"
        default: return raw.capitalized
        }
    }
}
