package com.watercompanion.client

import android.os.Bundle
import android.webkit.WebView
import android.view.View
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }
    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(content)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (ViewCompat.getRootWindowInsets(content)?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
                    WindowInsetsControllerCompat(window, webView).hide(WindowInsetsCompat.Type.ime())
                    return
                }
                webView.evaluateJavascript("!window.dispatchEvent(new Event('companion-back', {cancelable:true}))") { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })
    }
}
