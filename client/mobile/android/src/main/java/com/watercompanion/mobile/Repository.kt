package com.watercompanion.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.KeyStore
import java.time.ZoneId
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

internal data class Reply(val status: Int, val data: JSONObject)
internal data class Identity(val origin: String, val token: String?, val generation: Long)
internal object Policy {
    fun origin(address: String): String {
        val uri = URI(address)
        require(uri.scheme in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
            uri.rawQuery == null && uri.rawFragment == null && uri.rawPath in listOf("", "/") && uri.port != 0 && uri.port <= 65535) { "服务器地址无效。" }
        return address.trimEnd('/')
    }
    fun allowed(path: String, write: Boolean): Boolean {
        if (write) return path in listOf("/api/auth/login", "/api/auth/register", "/api/auth/logout", "/api/devices/bind", "/api/devices/unbind", "/api/control/cup", "/api/enrollment/operations", "/api/provisioning/operations") ||
            Regex("/api/events/[a-zA-Z0-9-]+/revoke").matches(path)
        return path in listOf("/api/health", "/api/auth/session", "/api/dashboard") ||
            Regex("/api/dashboard\\?date=\\d{4}-\\d{2}-\\d{2}").matches(path) ||
            Regex("/api/(control/commands|enrollment/operations|provisioning/operations)/[a-zA-Z0-9-]+").matches(path)
    }
    fun token(headers: List<String>, secure: Boolean): String? {
        val tokens = headers.filter { secure || it.split(';').drop(1).none { part -> part.trim().equals("secure", true) } }
            .map { it.substringBefore(';').trim() }.filter { it.startsWith("coaster_session=") }.map { it.substringAfter('=') }
        return tokens.singleOrNull()?.takeIf { Regex("[a-f0-9]{64}").matches(it) }
    }
    fun currentDay(data: JSONObject, now: java.time.Instant = java.time.Instant.now()): Boolean = try {
        data.getString("date") == now.atZone(ZoneId.of(data.getString("timeZone"))).toLocalDate().toString()
    } catch (_: Exception) { false }
}

internal class Repository private constructor(private val context: Context) {
    private val prefs = context.getSharedPreferences("companion", Context.MODE_PRIVATE)
    private val lock = Any()
    private val connections = ConcurrentHashMap.newKeySet<HttpURLConnection>()
    private val epoch = SessionEpoch(prefs.getLong("generation", 0), prefs.getString("user", null)?.let {
        Binding(it, prefs.getString("device", null), prefs.getString("binding", null))
    })
    private var origin = prefs.getString("server", null)
    private var character = prefs.getString("character", null)?.let(Character::from)
    private var token: String? = null
    private var storageError: String? = null

    init {
        try { token = prefs.getString("session", null)?.let { decrypt(it) }?.takeIf { Regex("[a-f0-9]{64}").matches(it) } }
        catch (_: Exception) { storageError = "保存的登录信息无法读取，请重新登录。"; prefs.edit().remove("session").remove("dashboard").remove("user").commit() }
    }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("water-companion-session", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("water-companion-session", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun encrypt(value: String): String {
        return Base64.encodeToString(SessionCipher.encrypt(value, origin!!, key()), Base64.NO_WRAP)
    }
    private fun decrypt(value: String): String {
        return SessionCipher.decrypt(Base64.decode(value, Base64.NO_WRAP), origin!!, key())
    }
    fun status(): JSONObject = synchronized(lock) {
        JSONObject().put("server", origin ?: JSONObject.NULL).put("generation", epoch.value).put("signedIn", token != null)
            .put("character", character?.id ?: JSONObject.NULL)
            .put("error", storageError ?: JSONObject.NULL)
    }
    fun setCharacter(value: String): JSONObject {
        val selected = Character.from(value)
        require(selected.id == value) { "未知的陪伴形象。" }
        synchronized(lock) {
            check(prefs.edit().putString("character", selected.id).commit()) { "无法保存陪伴形象，请重试。" }
            character = selected
        }
        CompanionWidget.renderAll(context)
        return status()
    }
    fun signedIn(): Boolean = synchronized(lock) { token != null }
    fun cache(): JSONObject? = synchronized(lock) { if (token == null) return@synchronized null; prefs.getString("dashboard", null)?.let { runCatching { JSONObject(it) }.getOrNull() } }
    private fun cancelLocked() {
        connections.forEach { it.disconnect() }
        connections.clear()
    }
    private fun clearLocked() {
        epoch.advance()
        epoch.observe(null)
        token = null
        cancelLocked()
        check(prefs.edit().putLong("generation", epoch.value).remove("session").remove("dashboard").remove("user").remove("device").remove("binding").commit()) { "无法清除本机登录信息。" }
    }
    private fun observeLocked(next: Binding): Boolean {
        if (!epoch.observe(next)) return false
        cancelLocked()
        check(prefs.edit().putLong("generation", epoch.value).putString("user", next.user).putString("device", next.device)
            .putString("binding", next.batch).remove("dashboard").commit()) { "无法保存绑定状态。" }
        return true
    }
    fun configure(address: String): JSONObject {
        val target = Policy.origin(address)
        require(target.startsWith("https://") || (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) { "安卓安装版请使用 HTTPS 地址；HTTP 仅用于调试版本。" }
        val before = synchronized(lock) { epoch.value }
        val response = transport(target, "/api/health", null, null, 8000).first
        require(response.status in 200..299 && response.data.optBoolean("ok")) { "此地址没有返回饮水服务的健康状态。" }
        synchronized(lock) {
            check(epoch.accepts(before)) { "连接已变化，请重试。" }
            if (origin == target) return status()
            clearLocked()
            origin = target
            check(prefs.edit().putString("server", target).commit()) { "无法保存服务器地址。" }
            storageError = null
        }
        CompanionWidget.reconcile(context)
        return status()
    }
    fun request(path: String, body: String?, timeout: Int = 8000): Reply {
        require(Policy.allowed(path, body != null)) { "此客户端不允许访问该接口。" }
        val auth = path in listOf("/api/auth/login", "/api/auth/register")
        val logout = path == "/api/auth/logout"
        val identity = synchronized(lock) {
            val server = origin ?: error("请先配置服务器地址。")
            if (auth) clearLocked()
            val saved = token
            if (logout) clearLocked()
            Identity(server, saved.takeUnless { auth }, epoch.value)
        }
        if (auth || logout) CompanionWidget.reconcile(context)
        val result = try { transport(identity.origin, path, body, identity.token, timeout, identity.generation) }
        catch (error: Exception) {
            if (logout) return Reply(200, JSONObject().put("ok", true).put("message", "已在本机退出；暂时无法确认云端注销。"))
            throw error
        }
        var updateWidgets = false
        synchronized(lock) {
            check(epoch.accepts(identity.generation) && identity.origin == origin) { "账号、服务器或绑定已变化，已忽略旧请求。" }
            val reply = result.first
            if (auth && reply.status in 200..299) {
                val next = Policy.token(result.second, identity.origin.startsWith("https://")) ?: error("服务器没有返回有效登录会话。")
                require(!reply.data.isNull("user")) { "服务器没有返回有效账号。" }
                check(prefs.edit().putString("session", encrypt(next)).putString("user", reply.data.getJSONObject("user").getString("id")).commit()) { "无法保存登录信息。" }
                token = next
                observeLocked(Binding(reply.data.getJSONObject("user").getString("id"), reply.data.stringOrNull("deviceId"), reply.data.stringOrNull("bindingId")))
                storageError = null
                updateWidgets = true
            } else if (reply.status == 401 || (path == "/api/auth/session" && reply.status in 200..299 && reply.data.isNull("user"))) {
                clearLocked()
                updateWidgets = true
            } else if (path == "/api/auth/session" && reply.status in 200..299 && token != null) {
                updateWidgets = observeLocked(Binding(reply.data.getJSONObject("user").getString("id"), reply.data.stringOrNull("deviceId"), reply.data.stringOrNull("bindingId")))
            } else if (path in listOf("/api/devices/bind", "/api/devices/unbind") && reply.status in 200..299) {
                epoch.advance()
                cancelLocked()
                check(prefs.edit().putLong("generation", epoch.value).remove("dashboard").commit()) { "无法清理旧饮水快照。" }
                updateWidgets = true
            } else if (path.startsWith("/api/dashboard") && reply.status in 200..299 && token != null && Policy.currentDay(reply.data)) {
                val device = reply.data.optJSONObject("device")
                epoch.binding?.let { observeLocked(Binding(it.user, device?.stringOrNull("id"), device?.stringOrNull("bindingId"))) }
                val cache = JSONObject().put("data", reply.data).put("syncedAt", System.currentTimeMillis()).put("offline", false)
                check(prefs.edit().putString("dashboard", cache.toString()).commit()) { "无法保存饮水快照。" }
                updateWidgets = true
            }
        }
        if (updateWidgets) CompanionWidget.reconcile(context)
        if (path.startsWith("/api/dashboard?") && result.first.status in 200..299 && !Policy.currentDay(result.first.data)) CompanionWidget.refresh(context)
        return result.first
    }
    fun sync() {
        if (!signedIn()) return
        val before = synchronized(lock) { epoch.value }
        try {
            val session = request("/api/auth/session", null)
            if (!signedIn()) return
            check(session.status in 200..299)
            check(request("/api/dashboard", null).status in 200..299)
        } catch (_: Exception) {
            synchronized(lock) {
                if (epoch.accepts(before)) cache()?.let { prefs.edit().putString("dashboard", it.put("offline", true).toString()).commit() }
            }
            CompanionWidget.renderAll(context)
        }
    }
    private fun transport(server: String, path: String, body: String?, cookie: String?, timeout: Int, expected: Long? = null): Pair<Reply, List<String>> {
        val connection = URL(server + path).openConnection() as HttpURLConnection
        synchronized(lock) {
            check(expected == null || (epoch.accepts(expected) && server == origin)) { "账号、服务器或绑定已变化，请重试。" }
            connections.add(connection)
        }
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = timeout.coerceIn(1000, 30000)
            connection.readTimeout = connection.connectTimeout
            connection.useCaches = false
            connection.setRequestProperty("User-Agent", "WaterCompanion/0.1 Android")
            if (cookie != null) connection.setRequestProperty("Cookie", "coaster_session=$cookie")
            if (body != null) {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            if (status in 300..399) error("服务器要求跳转，请直接配置最终服务地址。")
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val bytes = stream?.use { it.readBytesLimited(4 * 1024 * 1024) } ?: byteArrayOf()
            val data = runCatching { JSONObject(String(bytes, Charsets.UTF_8)) }.getOrElse {
                if (status in 200..299) error("服务器返回的数据格式不正确。")
                JSONObject().put("message", "服务器请求失败（$status）。")
            }
            val cookies = connection.headerFields.entries.filter { it.key?.equals("Set-Cookie", true) == true }.flatMap { it.value }
            return Reply(status, data) to cookies
        } catch (error: javax.net.ssl.SSLException) { throw IllegalStateException("HTTPS 证书验证失败，请检查服务器证书。") }
        catch (error: java.net.SocketTimeoutException) { throw IllegalStateException("连接超时，请检查网络和服务器地址。") }
        catch (error: java.io.IOException) { throw IllegalStateException("无法连接服务器，请检查网络和服务状态。") }
        finally { connections.remove(connection); connection.disconnect() }
    }
    companion object {
        @Volatile private var instance: Repository? = null
        fun get(context: Context): Repository = instance ?: synchronized(this) {
            instance ?: Repository(context.applicationContext).also { instance = it }
        }
    }
}
private fun JSONObject.stringOrNull(key: String): String? = if (isNull(key)) null else getString(key)
private fun java.io.InputStream.readBytesLimited(limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
        val size = read(buffer)
        if (size < 0) break
        require(output.size() + size <= limit) { "服务器返回的数据过大。" }
        output.write(buffer, 0, size)
    }
    return output.toByteArray()
}
