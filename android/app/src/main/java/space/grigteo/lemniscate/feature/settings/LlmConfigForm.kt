package space.grigteo.lemniscate.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import space.grigteo.lemniscate.core.api.LlmConfigDto
import space.grigteo.lemniscate.core.api.LlmConfigPayload
import space.grigteo.lemniscate.core.api.LlmTestResult

/**
 * Add/edit dialog for one LLM config. "Test connection" posts the unsaved
 * payload, or the saved config id when editing with an untouched API key.
 */
@Composable
fun LlmConfigFormDialog(
    initial: LlmConfigDto?,
    busy: Boolean,
    onSave: (LlmConfigPayload) -> Unit,
    onTest: suspend (savedId: String?, payload: LlmConfigPayload) -> LlmTestResult,
    onDismiss: () -> Unit,
) {
    var form by remember { mutableStateOf(initial?.toFormState() ?: LlmConfigFormState()) }
    var formError by remember { mutableStateOf<String?>(null) }
    var testResult by remember { mutableStateOf<LlmTestResult?>(null) }
    var testing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    val buildValid: () -> LlmConfigPayload? = {
        when (val result = buildPayload(form)) {
            is PayloadResult.Valid -> { formError = null; result.payload }
            is PayloadResult.Invalid -> { formError = result.error; null }
        }
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(if (initial == null) "Add LLM config" else "Edit LLM config") },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                FormFields(form, initial, onChange = { form = it })
                formError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                testResult?.let { TestResultBanner(it) }
            }
        },
        confirmButton = {
            Row {
                TextButton(
                    enabled = !busy && !testing,
                    onClick = {
                        val payload = buildValid() ?: return@TextButton
                        testing = true
                        testResult = null
                        scope.launch {
                            val savedId = initial?.id?.takeIf { form.apiKey.isBlank() }
                            testResult = onTest(savedId, payload)
                            testing = false
                        }
                    },
                ) {
                    if (testing) CircularProgressIndicator(modifier = Modifier.padding(4.dp), strokeWidth = 2.dp)
                    else Text("Test connection")
                }
                Button(
                    enabled = !busy && !testing,
                    onClick = { buildValid()?.let(onSave) },
                ) { Text(if (busy) "Saving…" else "Save") }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") }
        },
    )
}

@Composable
private fun FormFields(
    form: LlmConfigFormState,
    initial: LlmConfigDto?,
    onChange: (LlmConfigFormState) -> Unit,
) {
    Field("Name", form.name) { onChange(form.copy(name = it)) }
    Field("Base URL", form.baseUrl, placeholder = "https://api.openai.com/v1") { onChange(form.copy(baseUrl = it)) }
    Field(
        "API key",
        form.apiKey,
        placeholder = if (initial?.hasApiKey == true) "Leave blank to keep the stored key" else "",
        secret = true,
    ) { onChange(form.copy(apiKey = it)) }
    Field("Model", form.model) { onChange(form.copy(model = it)) }
    ThinkingLevelDropdown(form.thinkingLevel) { onChange(form.copy(thinkingLevel = it)) }
    Field("Temperature", form.temperature, numeric = true) { onChange(form.copy(temperature = it)) }
    Field("Max tokens", form.maxTokens, numeric = true) { onChange(form.copy(maxTokens = it)) }
    Field("Context window", form.contextWindow, numeric = true) { onChange(form.copy(contextWindow = it)) }
    Field("Extra system prompt", form.systemPromptExtra, singleLine = false) {
        onChange(form.copy(systemPromptExtra = it))
    }
    Field("Timeout (seconds)", form.timeoutSeconds, numeric = true) { onChange(form.copy(timeoutSeconds = it)) }
    Field("Max retries", form.maxRetries, numeric = true) { onChange(form.copy(maxRetries = it)) }
    Field("Requests per minute", form.requestsPerMinute, numeric = true) {
        onChange(form.copy(requestsPerMinute = it))
    }
    Field("Max tokens per run", form.maxTokensPerRun, numeric = true) {
        onChange(form.copy(maxTokensPerRun = it))
    }
    Field("Custom headers (JSON)", form.customHeaders, singleLine = false, placeholder = "{\"X-Key\": \"value\"}") {
        onChange(form.copy(customHeaders = it))
    }
    SwitchRow("Default config", form.isDefault) { onChange(form.copy(isDefault = it)) }
    SwitchRow("Enabled", form.enabled) { onChange(form.copy(enabled = it)) }
}

@Composable
private fun Field(
    label: String,
    value: String,
    placeholder: String = "",
    secret: Boolean = false,
    numeric: Boolean = false,
    singleLine: Boolean = true,
    onValue: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValue,
        label = { Text(label) },
        placeholder = { if (placeholder.isNotEmpty()) Text(placeholder) },
        singleLine = singleLine,
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = if (numeric) KeyboardOptions(keyboardType = KeyboardType.Number) else KeyboardOptions.Default,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ThinkingLevelDropdown(value: String, onValue: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = it },
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    ) {
        OutlinedTextField(
            value = value,
            onValueChange = {},
            readOnly = true,
            label = { Text("Thinking level") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            THINKING_LEVELS.forEach { level ->
                DropdownMenuItem(text = { Text(level) }, onClick = { onValue(level); expanded = false })
            }
        }
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChecked: (Boolean) -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
    ) {
        Text(label)
        Switch(checked = checked, onCheckedChange = onChecked)
    }
}

@Composable
private fun TestResultBanner(result: LlmTestResult) {
    Surface(
        color = if (result.ok) MaterialTheme.colorScheme.primaryContainer
        else MaterialTheme.colorScheme.errorContainer,
        modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
    ) {
        Column(modifier = Modifier.padding(8.dp)) {
            if (result.ok) {
                Text("OK · ${result.latencyMs ?: 0} ms")
                result.modelEcho?.let { Text("Model: $it", style = MaterialTheme.typography.bodySmall) }
                result.reply?.let { Text("Reply: $it", style = MaterialTheme.typography.bodySmall) }
            } else {
                Text("Failed: ${result.error ?: "unknown error"}")
            }
        }
    }
}
