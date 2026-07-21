package space.grigteo.lemniscate.feature.main

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

interface TranscriptionListener {
    fun onPartial(text: String)
    fun onFinal(text: String)
    fun onError(message: String)
    fun onStopped()
}

/**
 * Thin wrapper around SpeechRecognizer. All methods must be called on the
 * main thread; call [destroy] when the owning composable leaves composition.
 */
class SpeechTranscriber(
    private val context: Context,
    private val listener: TranscriptionListener,
) {
    private var recognizer: SpeechRecognizer? = null

    fun start() {
        destroy()
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            listener.onError("Speech recognition is not available on this device")
            listener.onStopped()
            return
        }
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
            setRecognitionListener(InnerListener())
            startListening(recognizerIntent())
        }
    }

    fun stop() {
        recognizer?.stopListening()
    }

    fun destroy() {
        recognizer?.destroy()
        recognizer = null
    }

    private fun recognizerIntent(): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        }

    private inner class InnerListener : RecognitionListener {
        override fun onPartialResults(partialResults: Bundle?) {
            firstResult(partialResults)?.let(listener::onPartial)
        }

        override fun onResults(results: Bundle?) {
            firstResult(results)?.let(listener::onFinal)
            listener.onStopped()
        }

        override fun onError(error: Int) {
            if (error != SpeechRecognizer.ERROR_CLIENT) {
                listener.onError("Speech recognition error ($error)")
            }
            listener.onStopped()
        }

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        private fun firstResult(bundle: Bundle?): String? =
            bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
    }
}
