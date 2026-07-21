package space.grigteo.lemniscate.feature.settings

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import space.grigteo.lemniscate.core.api.LlmConfigDto
import space.grigteo.lemniscate.core.api.LlmConfigPayload
import space.grigteo.lemniscate.core.api.apiJson

/**
 * Form state and payload builder for the LLM config add/edit form — a port of
 * the web llm-config-form.ts. Every value is a string (except booleans);
 * [buildPayload] validates and converts into the API payload shape.
 */
data class LlmConfigFormState(
    val name: String = "",
    val baseUrl: String = "",
    val apiKey: String = "",
    val model: String = "",
    val thinkingLevel: String = "off",
    val temperature: String = "0.2",
    val maxTokens: String = "",
    val contextWindow: String = "",
    val systemPromptExtra: String = "",
    val timeoutSeconds: String = "120",
    val maxRetries: String = "3",
    val requestsPerMinute: String = "",
    val maxTokensPerRun: String = "",
    val customHeaders: String = "",
    val isDefault: Boolean = false,
    val enabled: Boolean = true,
)

val THINKING_LEVELS = listOf("off", "low", "medium", "high")

private fun numToInput(value: Number?): String = value?.toString() ?: ""

/** Map a saved config into form state; the stored API key stays blank. */
fun LlmConfigDto.toFormState() = LlmConfigFormState(
    name = name,
    baseUrl = baseUrl,
    model = model,
    thinkingLevel = thinkingLevel,
    temperature = numToInput(temperature),
    maxTokens = numToInput(maxTokens),
    contextWindow = numToInput(contextWindow),
    systemPromptExtra = systemPromptExtra ?: "",
    timeoutSeconds = numToInput(timeoutSeconds).ifBlank { "120" },
    maxRetries = numToInput(maxRetries).ifBlank { "3" },
    requestsPerMinute = numToInput(requestsPerMinute),
    maxTokensPerRun = numToInput(maxTokensPerRun),
    customHeaders = customHeaders
        ?.entries?.joinToString(",\n") { "\"${it.key}\": \"${it.value}\"" }
        ?.let { "{\n$it\n}" }
        ?: "",
    isDefault = isDefault,
    enabled = enabled,
)

sealed interface PayloadResult {
    data class Valid(val payload: LlmConfigPayload) : PayloadResult
    data class Invalid(val error: String) : PayloadResult
}

private fun parseCustomHeaders(raw: String): Pair<Map<String, String>?, String?> {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null to null
    val parsed = runCatching { apiJson.parseToJsonElement(trimmed).jsonObject }.getOrNull()
        ?: return null to "Custom headers must be a JSON object of key/value pairs."
    val headers = LinkedHashMap<String, String>(parsed.size)
    for ((key, value) in parsed) {
        val primitive = value as? JsonPrimitive
        if (primitive == null || !primitive.isString) {
            return null to "Custom headers values must be strings."
        }
        headers[key] = primitive.content
    }
    return headers to null
}

/** Build the API payload from the form, or return a validation error message. */
fun buildPayload(form: LlmConfigFormState): PayloadResult {
    if (form.name.isBlank() || form.baseUrl.isBlank() || form.model.isBlank()) {
        return PayloadResult.Invalid("Name, base URL and model are required.")
    }
    val numericError = validateNumerics(form)
    if (numericError != null) return PayloadResult.Invalid(numericError)
    val (headers, headersError) = parseCustomHeaders(form.customHeaders)
    if (headersError != null) return PayloadResult.Invalid(headersError)
    return PayloadResult.Valid(
        LlmConfigPayload(
            name = form.name.trim(),
            baseUrl = form.baseUrl.trim(),
            model = form.model.trim(),
            apiKey = form.apiKey.ifBlank { null },
            thinkingLevel = form.thinkingLevel,
            temperature = form.temperature.trim().toDoubleOrNull(),
            maxTokens = form.maxTokens.trim().toIntOrNull(),
            contextWindow = form.contextWindow.trim().toIntOrNull(),
            systemPromptExtra = form.systemPromptExtra.trim().ifBlank { null },
            timeoutSeconds = form.timeoutSeconds.trim().toIntOrNull(),
            maxRetries = form.maxRetries.trim().toIntOrNull(),
            requestsPerMinute = form.requestsPerMinute.trim().toIntOrNull(),
            maxTokensPerRun = form.maxTokensPerRun.trim().toIntOrNull(),
            customHeaders = headers,
            isDefault = form.isDefault,
            enabled = form.enabled,
        ),
    )
}

private fun validateNumerics(form: LlmConfigFormState): String? {
    val doubles = mapOf("temperature" to form.temperature)
    val ints = mapOf(
        "maxTokens" to form.maxTokens,
        "contextWindow" to form.contextWindow,
        "timeoutSeconds" to form.timeoutSeconds,
        "maxRetries" to form.maxRetries,
        "requestsPerMinute" to form.requestsPerMinute,
        "maxTokensPerRun" to form.maxTokensPerRun,
    )
    for ((field, raw) in doubles) {
        if (raw.isNotBlank() && raw.trim().toDoubleOrNull() == null) return "\"$field\" must be a number."
    }
    for ((field, raw) in ints) {
        if (raw.isNotBlank() && raw.trim().toIntOrNull() == null) return "\"$field\" must be a whole number."
    }
    return null
}
