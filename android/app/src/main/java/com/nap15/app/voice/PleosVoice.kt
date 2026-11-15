package com.nap15.app.voice

import ai.pleos.playground.tts.TextToSpeech
import ai.pleos.playground.tts.constant.ErrorType
import ai.pleos.playground.tts.constant.Mode
import ai.pleos.playground.tts.listener.OnInitializeListener
import android.content.Context
import android.media.AudioAttributes
import java.util.Locale

/**
 * 음성 안내. Pleos Connect 에서는 안드로이드 기본 TTS 대신 Pleos TextToSpeech SDK(3.3.1)를 쓴다.
 * 주차장·졸음쉼터에서는 통신이 안 될 수 있으므로 ON_DEVICE 모드로 고정한다.
 */
class PleosVoice(context: Context, private val onTrace: (String) -> Unit) {

    private val tts = TextToSpeech(context.applicationContext, Mode.ON_DEVICE)

    @Volatile private var ready = false
    @Volatile private var started = false
    @Volatile private var waiting: String? = null   // 초기화가 끝나기 전에 들어온 마지막 문장

    fun start() {
        if (started) return
        started = true
        try {
            tts.initialize(object : OnInitializeListener {
                override fun onSuccess() {
                    runCatching { tts.setLocale(Locale.KOREA) }
                    runCatching {
                        tts.setAudioAttributes(
                            AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build()
                        )
                    }
                    ready = true
                    onTrace("TextToSpeech.initialize(ON_DEVICE) → OK")
                    waiting?.let { speak(it) }
                    waiting = null
                }

                override fun onFailure(errorType: ErrorType) {
                    onTrace("TextToSpeech.initialize → 실패 $errorType")
                }
            })
        } catch (t: Throwable) {
            onTrace("TextToSpeech.initialize → 실패 ${t.message}")
        }
    }

    fun speak(text: String) {
        if (!ready) {
            waiting = text
            return
        }
        try {
            tts.stop()
            tts.speak(text, true)
        } catch (t: Throwable) {
            onTrace("TextToSpeech.speak → 실패 ${t.message}")
        }
    }

    fun stop() {
        waiting = null
        if (ready) runCatching { tts.stop() }
    }

    fun release() {
        ready = false
        runCatching { tts.release() }
    }
}
