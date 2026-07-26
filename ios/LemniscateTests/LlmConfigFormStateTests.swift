import XCTest
@testable import Lemniscate

final class LlmConfigFormStateTests: XCTestCase {

    private func validForm() -> LlmConfigFormState {
        var form = LlmConfigFormState()
        form.name = "OpenAI"
        form.model = "gpt-5"
        form.apiKey = "sk-test"
        return form
    }

    private func assertInvalid(_ form: LlmConfigFormState, _ message: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try form.payload(requireApiKey: true), file: file, line: line) { error in
            XCTAssertEqual((error as? FormError)?.message, message, file: file, line: line)
        }
    }

    func testValidFormBuildsPayload() throws {
        let payload = try validForm().payload(requireApiKey: true)
        XCTAssertEqual(payload.name, "OpenAI")
        XCTAssertEqual(payload.baseUrl, "https://api.openai.com/v1")
        XCTAssertEqual(payload.model, "gpt-5")
        XCTAssertEqual(payload.apiKey, "sk-test")
        XCTAssertEqual(payload.thinkingLevel, "off")
        XCTAssertEqual(payload.temperature, 0.2, accuracy: 0.0001)
        XCTAssertEqual(payload.timeoutSeconds, 120)
        XCTAssertEqual(payload.maxRetries, 3)
        XCTAssertNil(payload.maxTokensPerRun)
        XCTAssertEqual(payload.customHeaders, [:])
    }

    func testMissingNameIsRejected() {
        var form = validForm()
        form.name = "   "
        assertInvalid(form, "Name is required")
    }

    func testBaseURLMustBeHTTP() {
        var form = validForm()
        form.baseUrl = "api.openai.com"
        assertInvalid(form, "Base URL must start with http:// or https://")
    }

    func testMissingModelIsRejected() {
        var form = validForm()
        form.model = ""
        assertInvalid(form, "Model is required")
    }

    func testAPIKeyRequiredForNewConfigs() {
        var form = validForm()
        form.apiKey = ""
        assertInvalid(form, "API key is required")
        XCTAssertNoThrow(try form.payload(requireApiKey: false))
    }

    func testTemperatureRangeIsEnforced() {
        var form = validForm()
        form.temperature = "2.5"
        assertInvalid(form, "Temperature must be a number between 0 and 2")
        form.temperature = "hot"
        assertInvalid(form, "Temperature must be a number between 0 and 2")
    }

    func testTimeoutRangeIsEnforced() {
        var form = validForm()
        form.timeoutSeconds = "601"
        assertInvalid(form, "Timeout must be an integer in 1…600")
    }

    func testRetriesRangeIsEnforced() {
        var form = validForm()
        form.maxRetries = "11"
        assertInvalid(form, "Max retries must be an integer in 0…10")
    }

    func testOptionalBudgetIsNilWhenBlank() throws {
        var form = validForm()
        form.maxTokensPerRun = "  "
        XCTAssertNil(try form.payload(requireApiKey: true).maxTokensPerRun)
        form.maxTokensPerRun = "50000"
        XCTAssertEqual(try form.payload(requireApiKey: true).maxTokensPerRun, 50000)
    }

    func testCustomHeadersMustBeAStringObject() {
        var form = validForm()
        form.customHeadersJSON = "not json"
        assertInvalid(form, "Custom headers must be a JSON object of string pairs")
        form.customHeadersJSON = #"{"X-Key": 5}"#
        assertInvalid(form, "Custom headers must be a JSON object of string pairs")
    }

    func testValidCustomHeadersArePassedThrough() throws {
        var form = validForm()
        form.customHeadersJSON = #"{"X-Org": "nous"}"#
        XCTAssertEqual(try form.payload(requireApiKey: true).customHeaders, ["X-Org": "nous"])
    }

    func testInitFromConfigMapsFieldsAndKeepsKeyBlank() throws {
        let config = try JSONDecoder().decode(LlmConfig.self, from: Data(#"""
        {
            "id": "cfg_1", "name": "OpenAI", "baseUrl": "https://api.openai.com/v1",
            "model": "gpt-5", "hasApiKey": true, "thinkingLevel": "medium",
            "temperature": 0.7, "maxTokens": 4096, "contextWindow": 128000,
            "customHeaders": {"X-Org": "nous"}, "isDefault": true, "enabled": true
        }
        """#.utf8))
        let form = LlmConfigFormState(config: config)
        XCTAssertEqual(form.name, "OpenAI")
        XCTAssertEqual(form.apiKey, "")
        XCTAssertTrue(form.hasStoredApiKey)
        XCTAssertEqual(form.thinkingLevel, "medium")
        XCTAssertEqual(form.temperature, "0.7")
        XCTAssertEqual(form.maxTokens, "4096")
        XCTAssertTrue(form.customHeadersJSON.contains("X-Org"))
        XCTAssertTrue(form.isDefault)
    }
}
