package com.nap15.app

import android.webkit.JavascriptInterface

/**
 * 화면(web/js/vehicle.js)이 부르는 창구. 자바스크립트에서는 window.NapNative 로 보인다.
 * 이 메서드들은 WebView 의 별도 스레드에서 불린다.
 */
class NapBridge(
    private val onAct: (kind: String, value: String) -> Boolean,
    private val onSpeak: (String) -> Unit,
    private val onStopSpeaking: () -> Unit,
    private val capabilities: () -> String,
) {
    /** kind: lockDoors | closeWindows | recirc | backrest | fan | dim */
    @JavascriptInterface
    fun act(kind: String?, value: String?): Boolean =
        try { onAct(kind ?: "", value ?: "") } catch (t: Throwable) { false }

    @JavascriptInterface
    fun speak(text: String?) {
        if (!text.isNullOrBlank()) onSpeak(text)
    }

    @JavascriptInterface
    fun stopSpeaking() = onStopSpeaking()

    /** {"doorLock":true,"windows":true,"recirc":true,"backrest":true,"fan":true} */
    @JavascriptInterface
    fun capabilities(): String = try { capabilities.invoke() } catch (t: Throwable) { "{}" }
}
