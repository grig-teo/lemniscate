package space.grigteo.lemniscate.feature.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import space.grigteo.lemniscate.core.api.LlmConfigDto

class LlmConfigFormStateTest {

    private fun validForm() = LlmConfigFormState(
        name = "OpenAI",
        baseUrl = "https://api.openai.com/v1",
        model = "gpt-5",
    )

    private fun validPayloadOf(form: LlmConfigFormState) =
        (buildPayload(form) as PayloadResult.Valid).payload

    @Test
    fun `blank required fields are rejected`() {
        val result = buildPayload(LlmConfigFormState())
        assertEquals(
            PayloadResult.Invalid("Name, base URL and model are required."),
            result,
        )
    }

    @Test
    fun `valid form builds trimmed payload with defaults`() {
        val payload = validPayloadOf(
            validForm().copy(name = "  OpenAI  ", timeoutSeconds = "120", maxRetries = "3"),
        )
        assertEquals("OpenAI", payload.name)
        assertEquals(120, payload.timeoutSeconds)
        assertEquals(3, payload.maxRetries)
        assertEquals("off", payload.thinkingLevel)
        assertNull(payload.apiKey)
        assertNull(payload.customHeaders)
    }

    @Test
    fun `non-numeric temperature is rejected`() {
        assertEquals(
            PayloadResult.Invalid("\"temperature\" must be a number."),
            buildPayload(validForm().copy(temperature = "abc")),
        )
    }

    @Test
    fun `non-integer numeric field is rejected`() {
        assertEquals(
            PayloadResult.Invalid("\"maxRetries\" must be a whole number."),
            buildPayload(validForm().copy(maxRetries = "3.5")),
        )
    }

    @Test
    fun `blank optional numerics become null`() {
        val payload = validPayloadOf(validForm().copy(maxTokens = "", requestsPerMinute = " "))
        assertNull(payload.maxTokens)
        assertNull(payload.requestsPerMinute)
    }

    @Test
    fun `custom headers must be a JSON object`() {
        assertEquals(
            PayloadResult.Invalid("Custom headers must be a JSON object of key/value pairs."),
            buildPayload(validForm().copy(customHeaders = "not json")),
        )
    }

    @Test
    fun `custom header values must be strings`() {
        assertEquals(
            PayloadResult.Invalid("Custom headers values must be strings."),
            buildPayload(validForm().copy(customHeaders = """{"X-Key": 5}""")),
        )
    }

    @Test
    fun `valid custom headers are passed through`() {
        val payload = validPayloadOf(
            validForm().copy(customHeaders = """{"X-Org": "nous", "X-Team": "mobile"}"""),
        )
        assertEquals(mapOf("X-Org" to "nous", "X-Team" to "mobile"), payload.customHeaders)
    }

    @Test
    fun `saved config maps into form state with blank api key and defaults`() {
        val config = LlmConfigDto(
            id = "cfg_1",
            name = "OpenAI",
            baseUrl = "https://api.openai.com/v1",
            model = "gpt-5",
            hasApiKey = true,
            temperature = 0.7,
            maxTokens = 4096,
            timeoutSeconds = null,
            customHeaders = mapOf("X-Org" to "nous"),
        )
        val form = config.toFormState()
        assertEquals("OpenAI", form.name)
        assertEquals("", form.apiKey)
        assertEquals("0.7", form.temperature)
        assertEquals("4096", form.maxTokens)
        assertEquals("120", form.timeoutSeconds)
        assertEquals("3", form.maxRetries)
        assertTrue(form.customHeaders.contains("\"X-Org\": \"nous\""))
    }
}
