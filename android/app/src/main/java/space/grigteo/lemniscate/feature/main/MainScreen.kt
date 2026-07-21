package space.grigteo.lemniscate.feature.main

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import space.grigteo.lemniscate.LemniscateApp
import space.grigteo.lemniscate.R
import space.grigteo.lemniscate.feature.settings.SettingsDialog

/** Main screen: repo picker, big mic button, live transcript, settings. */
@Composable
fun MainScreen() {
    val app = LocalContext.current.applicationContext as LemniscateApp
    val viewModel: MainViewModel = viewModel(factory = MainViewModel.factory(app))
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val snackbarHost = remember { SnackbarHostState() }
    var showRepoPicker by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }

    LaunchedEffect(ui.snackbar) {
        ui.snackbar?.let {
            snackbarHost.showSnackbar(it)
            viewModel.dismissSnackbar()
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHost) },
        topBar = { MainTopBar(ui, onPickRepo = { showRepoPicker = true }, onSettings = { showSettings = true }) },
    ) { padding ->
        MainContent(viewModel, ui, Modifier.fillMaxSize().padding(padding))
    }

    if (showRepoPicker) {
        RepoPickerDialog(
            ui = ui,
            onLoadRunning = viewModel::loadRunningTasks,
            onSelect = { viewModel.selectRepo(it); showRepoPicker = false },
            onDismiss = { showRepoPicker = false },
        )
    }
    if (showSettings) {
        SettingsDialog(onDismiss = { showSettings = false })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MainTopBar(ui: MainUiState, onPickRepo: () -> Unit, onSettings: () -> Unit) {
    TopAppBar(
        title = {
            TextButton(onClick = onPickRepo) {
                Text(ui.selectedRepo?.fullName ?: "Select repository")
            }
        },
        actions = {
            IconButton(onClick = onSettings) {
                Icon(Icons.Default.Settings, contentDescription = "Settings")
            }
        },
    )
}

@Composable
private fun MainContent(viewModel: MainViewModel, ui: MainUiState, modifier: Modifier) {
    Column(
        modifier = modifier.padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        MicButton(viewModel, ui)
        Spacer(Modifier.height(16.dp))
        StatusHint(ui)
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = ui.transcript,
            onValueChange = viewModel::editTranscript,
            label = { Text("Task prompt") },
            enabled = !ui.sending,
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun StatusHint(ui: MainUiState) {
    val text = when {
        ui.selectedRepo == null -> "Pick a repository to enable the microphone"
        ui.sending -> "Creating task…"
        ui.recording -> "Listening… tap again to send"
        else -> "Tap the mic and describe the task"
    }
    Text(text, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
}

/** Large circular mic button; toggles recording and submits the transcript on stop. */
@Composable
private fun MicButton(viewModel: MainViewModel, ui: MainUiState) {
    val context = LocalContext.current
    val transcriber = remember {
        SpeechTranscriber(context, object : TranscriptionListener {
            override fun onPartial(text: String) = viewModel.onPartialTranscript(text)
            override fun onFinal(text: String) = viewModel.onFinalTranscript(text)
            override fun onError(message: String) { viewModel.showError(message) }
            override fun onStopped() {
                viewModel.setRecording(false)
                viewModel.submitPrompt()
            }
        })
    }
    DisposableEffect(Unit) { onDispose { transcriber.destroy() } }

    val startRecording = {
        viewModel.setRecording(true)
        transcriber.start()
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) startRecording() else viewModel.showError("Microphone permission denied") }

    val onToggle = {
        if (ui.recording) {
            transcriber.stop()
        } else {
            val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
            if (granted) startRecording() else permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    Button(
        onClick = { if (!ui.sending) onToggle() },
        enabled = ui.selectedRepo != null && !ui.sending,
        shape = CircleShape,
        modifier = Modifier.size(128.dp),
        colors = if (ui.recording) {
            ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error)
        } else {
            ButtonDefaults.buttonColors()
        },
    ) {
        Icon(
            painterResource(R.drawable.ic_mic),
            contentDescription = if (ui.recording) "Stop recording" else "Start recording",
            modifier = Modifier.size(48.dp),
        )
    }
}
