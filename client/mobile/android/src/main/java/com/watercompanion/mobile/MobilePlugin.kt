package com.watercompanion.mobile

import android.Manifest
import android.app.Activity
import android.os.Build
import android.os.Handler
import android.os.Looper
import app.tauri.PermissionState
import app.tauri.annotation.*
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import kotlinx.coroutines.*

@InvokeArg class ConfigureArgs { lateinit var address: String }
@InvokeArg class CharacterArgs { lateinit var character: String }
@InvokeArg class RequestArgs { lateinit var path: String; var body: String? = null; var timeoutMs: Int = 8000 }
@InvokeArg class DisconnectArgs { var connection: Long? = null }
@InvokeArg class ConnectArgs { lateinit var id: String }
@InvokeArg class GattArgs { lateinit var uuid: String; var connection: Long = 0; var value: String? = null }

@TauriPlugin(permissions = [
    Permission(alias = "nearby", strings = [Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT]),
    Permission(alias = "location", strings = [Manifest.permission.ACCESS_FINE_LOCATION])
])
class MobilePlugin(private val activity: Activity) : Plugin(activity) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val repository by lazy { Repository.get(activity) }
    private val ble by lazy { BleClient(activity) { trigger("ble", it) } }
    @Volatile private var foreground = true
    private val lifecycle = Handler(Looper.getMainLooper())
    private var stopped = false
    private val pauseWhenReady = object : Runnable {
        override fun run() {
            if (!stopped) return
            if (ble.background()) { foreground = false; trigger("lifecycle", JSObject().put("active", false)) }
            else lifecycle.postDelayed(this, 1000)
        }
    }
    private fun io(invoke: Invoke, action: () -> JSObject) {
        scope.launch {
            try { val value = action(); withContext(Dispatchers.Main) { invoke.resolve(value) } }
            catch (cause: Exception) { withContext(Dispatchers.Main) { invoke.reject(cause.message ?: "操作失败，请重试。") } }
        }
    }
    @Command fun configure(invoke: Invoke) {
        val args = invoke.parseArgs(ConfigureArgs::class.java)
        ble.disconnect()
        io(invoke) { JSObject(repository.configure(args.address).toString()) }
    }
    @Command fun status(invoke: Invoke) = io(invoke) { JSObject(repository.status().put("active", foreground).toString()) }
    @Command fun setCharacter(invoke: Invoke) {
        val args = invoke.parseArgs(CharacterArgs::class.java)
        io(invoke) { JSObject(repository.setCharacter(args.character).toString()) }
    }
    @Command fun request(invoke: Invoke) {
        val args = invoke.parseArgs(RequestArgs::class.java)
        if (args.path in listOf("/api/auth/logout", "/api/auth/login", "/api/auth/register")) ble.disconnect()
        io(invoke) {
            val result = repository.request(args.path, args.body, args.timeoutMs)
            JSObject().put("status", result.status).put("data", result.data)
        }
    }
    @Command fun pinWidget(invoke: Invoke) { invoke.resolve(JSObject().put("supported", CompanionWidget.pin(activity))) }
    @Command fun choose(invoke: Invoke) {
        val alias = if (Build.VERSION.SDK_INT >= 31) "nearby" else "location"
        if (getPermissionState(alias) != PermissionState.GRANTED) requestPermissionForAlias(alias, invoke, "permissionsResult")
        else ble.choose(invoke)
    }
    @PermissionCallback fun permissionsResult(invoke: Invoke) {
        val alias = if (Build.VERSION.SDK_INT >= 31) "nearby" else "location"
        if (getPermissionState(alias) == PermissionState.GRANTED) ble.choose(invoke)
        else invoke.reject("蓝牙权限未开启，请在系统应用设置中允许后重试。", "BLE_PERMISSION_DENIED")
    }
    @Command fun connect(invoke: Invoke) { ble.connect(invoke.parseArgs(ConnectArgs::class.java).id, invoke) }
    private fun gatt(kind: String, invoke: Invoke) {
        val args = invoke.parseArgs(GattArgs::class.java)
        ble.operate(kind, args.uuid, args.connection, args.value, invoke)
    }
    @Command fun read(invoke: Invoke) = gatt("read", invoke)
    @Command fun write(invoke: Invoke) = gatt("write", invoke)
    @Command fun subscribe(invoke: Invoke) = gatt("subscribe", invoke)
    @Command fun disconnect(invoke: Invoke) { ble.disconnect(invoke.parseArgs(DisconnectArgs::class.java).connection); invoke.resolve() }
    override fun onStop() { stopped = true; pauseWhenReady.run() }
    override fun onResume() { stopped = false; lifecycle.removeCallbacks(pauseWhenReady); foreground = true; trigger("lifecycle", JSObject().put("active", true)) }
    override fun onDestroy() { lifecycle.removeCallbacks(pauseWhenReady); ble.disconnect(); scope.cancel() }
}
