import Foundation

enum ApiError: LocalizedError {
    case unauthorized
    case server(status: Int, message: String)
    case transport(String)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Session expired. Please sign in again."
        case .server(let status, let message):
            return message.isEmpty ? "Server error (\(status))" : message
        case .transport(let message):
            return message
        case .invalidResponse:
            return "Unexpected server response."
        }
    }
}

private struct ErrorBody: Decodable {
    let error: String
}

/// Cookie-authenticated JSON client. Uses URLSession.shared so cookies flow
/// through HTTPCookieStorage.shared (same store SessionStore writes to).
struct APIClient: Sendable {
    static let shared = APIClient()

    private init() {}

    func request<T: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable)? = nil
    ) async throws -> T {
        let (data, response) = try await perform(method, path, query: query, body: body)
        try validate(response, data: data)
        guard let decoded = try? JSONDecoder().decode(T.self, from: data) else {
            throw ApiError.invalidResponse
        }
        return decoded
    }

    func send(_ method: String, _ path: String, body: (any Encodable)? = nil) async throws {
        let (data, response) = try await perform(method, path, body: body)
        try validate(response, data: data)
    }

    private func perform(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable)?
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: Endpoints.url(path, query: query))
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw ApiError.invalidResponse
            }
            return (data, http)
        } catch let error as ApiError {
            throw error
        } catch {
            throw ApiError.transport(error.localizedDescription)
        }
    }

    private func validate(_ response: HTTPURLResponse, data: Data) throws {
        guard !(200..<300).contains(response.statusCode) else { return }
        if response.statusCode == 401 {
            throw ApiError.unauthorized
        }
        let serverMessage = try? JSONDecoder().decode(ErrorBody.self, from: data).error
        let fallback = HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
        throw ApiError.server(status: response.statusCode, message: serverMessage ?? fallback)
    }
}
