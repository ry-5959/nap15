package com.nap15.app

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import com.nap15.app.vehicle.PleosVehicleGateway
import com.nap15.app.voice.PleosVoice
import org.json.JSONObject

/**
 * 화면은 web/ 폴더의 HTML·JS 그대로다(브라우저 시제품과 같은 코드).
 * 이 액티비티는 그 화면을 띄우고, 차량(SDK)·음성(TTS)과 이어 주기만 한다.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var gateway: PleosVehicleGateway
    private lateinit var voice: PleosVoice
    @Volatile private var pageReady = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this)
        web.setBackgroundColor(0xFF0E1B33.toInt())
        web.overScrollMode = WebView.OVER_SCROLL_NEVER
        setContentView(web, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true                    // 최근 7일 기록(localStorage)
            mediaPlaybackRequiresUserGesture = false    // 깨울 때 알림음
            blockNetworkLoads = true                    // 화면은 앱 안의 파일만 쓴다(통신 없이 동작)
            textZoom = 100
            setSupportZoom(false)
        }

        gateway = PleosVehicleGateway(
            context = this,
            onSignals = { json -> toPage("window.__nap && window.__nap.onSignals($json)") },
            onTrace = { line -> toPage("window.__nap && window.__nap.onSdkTrace(${JSONObject.quote(line)})") },
        )
        voice = PleosVoice(this) { line ->
            runOnUiThread { toPage("window.__nap && window.__nap.onSdkTrace(${JSONObject.quote(line)})") }
        }

        web.addJavascriptInterface(
            NapBridge(
                onAct = { kind, value -> if (kind == "dim") dim(value) else gateway.act(kind, value) },
                onSpeak = { text -> runOnUiThread { voice.speak(text) } },
                onStopSpeaking = { runOnUiThread { voice.stop() } },
                capabilities = { gateway.capabilitiesJson() },
            ),
            "NapNative",
        )
        web.webViewClient = object : android.webkit.WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                pageReady = true
            }
        }
        web.loadUrl("file:///android_asset/web/index.html")

        gateway.start()
        voice.start()
    }

    /** 화면 밝기. 1 이상이면 시스템 설정으로 되돌린다. */
    private fun dim(value: String): Boolean {
        val level = value.toFloatOrNull() ?: return false
        runOnUiThread {
            val lp = window.attributes
            lp.screenBrightness = if (level >= 1f) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            else level.coerceIn(0.01f, 1f)
            window.attributes = lp
        }
        return true
    }

    private fun toPage(js: String) {
        if (!pageReady || isDestroyed) return
        web.evaluateJavascript(js, null)
    }

    override fun onDestroy() {
        pageReady = false
        gateway.release()
        voice.release()
        web.removeJavascriptInterface("NapNative")
        web.destroy()
        super.onDestroy()
    }
}
