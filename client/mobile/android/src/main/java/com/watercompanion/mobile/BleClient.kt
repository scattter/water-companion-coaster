package com.watercompanion.mobile

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.*
import android.bluetooth.le.*
import android.content.*
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import android.widget.ArrayAdapter
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import java.util.UUID

@SuppressLint("MissingPermission")
internal class BleClient(private val activity: Activity, private val emit: (JSObject) -> Unit) {
    private val handler = Handler(Looper.getMainLooper())
    private val serviceId = UUID.fromString("7d2a0001-7b9c-4e6a-9f21-531bd67a0c10")
    private val cccd = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    private val adapter get() = (activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private var selected: BluetoothDevice? = null
    private var gatt: BluetoothGatt? = null
    private var connection = 0L
    private var pending: Operation? = null
    private var scan: ScanCallback? = null
    private var chooser: AlertDialog? = null
    private var choice: Invoke? = null
    private var bondReceiver: BroadcastReceiver? = null
    private data class Operation(val kind: String, val uuid: String, val invoke: Invoke, val timeout: Runnable, val retry: () -> Boolean)

    private fun later(block: () -> Unit) { handler.post(block) }
    fun choose(invoke: Invoke) {
        disconnect()
        val bluetooth = adapter
        if (bluetooth == null || !bluetooth.isEnabled) { invoke.reject("请先开启手机蓝牙。"); return }
        val devices = mutableListOf<BluetoothDevice>()
        val labels = ArrayAdapter<String>(activity, android.R.layout.simple_list_item_1)
        choice = invoke
        chooser = AlertDialog.Builder(activity).setTitle("选择杯垫 · 正在扫描")
            .setAdapter(labels) { _, index ->
                selected = devices[index]
                choice = null
                stopScan()
                invoke.resolve(JSObject().put("id", selected!!.address))
            }.setNegativeButton("取消") { _, _ -> cancelChoice() }
            .setOnCancelListener { cancelChoice() }.create()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) = later {
                if (choice !== invoke || devices.any { it.address == result.device.address }) return@later
                devices.add(result.device)
                labels.add("${result.scanRecord?.deviceName ?: "饮水杯垫"} · ${result.device.address.takeLast(5)}")
                chooser?.setTitle("选择你的杯垫")
            }
            override fun onScanFailed(errorCode: Int) = later { cancelChoice("蓝牙扫描失败（$errorCode），请重试。") }
        }
        scan = callback
        try {
            bluetooth.bluetoothLeScanner.startScan(listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(serviceId)).build()),
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), callback)
            chooser?.show()
            handler.postDelayed({ if (choice === invoke) cancelChoice("未选择杯垫，请确认配网窗口已开启后重试。") }, 55000)
        } catch (_: Exception) { cancelChoice("无法扫描蓝牙，请检查附近设备权限；旧版安卓还需开启定位服务。") }
    }
    private fun stopScan() {
        scan?.let { runCatching { adapter?.bluetoothLeScanner?.stopScan(it) } }
        scan = null
        chooser?.dismiss(); chooser = null
    }
    private fun cancelChoice(message: String = "已取消选择杯垫。") {
        val invoke = choice; choice = null
        stopScan(); invoke?.reject(message)
    }
    fun connect(id: String, invoke: Invoke) {
        val device = selected
        if (device == null || device.address != id) { invoke.reject("请先选择杯垫。"); return }
        disconnect()
        connection++
        begin("connect", "", invoke, 15000) { true }
        try { gatt = device.connectGatt(activity, false, callback, BluetoothDevice.TRANSPORT_LE) }
        catch (_: Exception) { fail("蓝牙连接失败，请检查权限并重试。") }
    }
    fun operate(kind: String, uuid: String, expected: Long, data: String?, invoke: Invoke) {
        val current = gatt
        val allowed = uuid.matches(Regex("7d2a000[2-5]-7b9c-4e6a-9f21-531bd67a0c10"))
        if (current == null || connection != expected || !allowed) { invoke.reject("蓝牙连接已变化，请重新连接。"); return }
        val characteristic = current.getService(serviceId)?.getCharacteristic(UUID.fromString(uuid))
        if (characteristic == null) { invoke.reject("杯垫未提供此蓝牙特征。"); return }
        if ((kind == "write" && uuid !in listOf("7d2a0003-7b9c-4e6a-9f21-531bd67a0c10", "7d2a0005-7b9c-4e6a-9f21-531bd67a0c10")) ||
            (kind == "subscribe" && uuid != "7d2a0004-7b9c-4e6a-9f21-531bd67a0c10")) { invoke.reject("不支持此蓝牙操作。"); return }
        val bytes = try { data?.let { Base64.decode(it, Base64.NO_WRAP) } } catch (_: Exception) { invoke.reject("蓝牙数据无效。"); return }
        if (bytes != null && bytes.size > 20) { invoke.reject("蓝牙分片过大。"); return }
        val action = {
            when (kind) {
                "read" -> current.readCharacteristic(characteristic)
                "write" -> {
                    val value = bytes ?: byteArrayOf()
                    if (Build.VERSION.SDK_INT >= 33) current.writeCharacteristic(characteristic, value, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
                    else { characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT; characteristic.value = value; current.writeCharacteristic(characteristic) }
                }
                "subscribe" -> {
                    val descriptor = characteristic.getDescriptor(cccd)
                    if (descriptor == null || !current.setCharacteristicNotification(characteristic, true)) false
                    else if (Build.VERSION.SDK_INT >= 33) current.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
                    else { descriptor.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; current.writeDescriptor(descriptor) }
                }
                else -> false
            }
        }
        if (!begin(kind, uuid, invoke, if (kind == "read") 60000 else 15000, action)) return
        try { if (!action()) fail("蓝牙操作未能开始，请重新连接。") }
        catch (_: Exception) { fail("蓝牙操作失败，请检查权限后重新连接。") }
    }
    private fun begin(kind: String, uuid: String, invoke: Invoke, timeoutMs: Long, retry: () -> Boolean): Boolean {
        if (pending != null) { invoke.reject("蓝牙正在处理上一项操作。"); return false }
        val timer = Runnable { if (pending?.invoke === invoke) fail("蓝牙操作超时，请重新连接后查询结果。") }
        pending = Operation(kind, uuid, invoke, timer, retry)
        handler.postDelayed(timer, timeoutMs)
        return true
    }
    private fun finish(value: JSObject = JSObject()) {
        val operation = pending ?: return
        pending = null
        handler.removeCallbacks(operation.timeout)
        removeBondReceiver()
        operation.invoke.resolve(value)
    }
    private fun fail(message: String) {
        val operation = pending; pending = null
        operation?.let { handler.removeCallbacks(it.timeout); it.invoke.reject(message) }
        disconnect()
    }
    private fun pairing(status: Int): Boolean {
        if (status != BluetoothGatt.GATT_INSUFFICIENT_AUTHENTICATION && status != BluetoothGatt.GATT_INSUFFICIENT_ENCRYPTION) return false
        val device = selected ?: return false
        if (device.bondState == BluetoothDevice.BOND_BONDED) return false
        if (bondReceiver == null) {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    @Suppress("DEPRECATION") val changed = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
                    if (changed?.address != device.address) return
                    if (device.bondState == BluetoothDevice.BOND_BONDED) {
                        removeBondReceiver()
                        val operation = pending ?: return
                        if (!operation.retry()) fail("配对后读取失败，请重新连接。")
                    } else if (device.bondState == BluetoothDevice.BOND_NONE) fail("蓝牙配对未完成，请确认杯垫屏幕上的配对码。")
                }
            }
            bondReceiver = receiver
            if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(receiver, IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED), Context.RECEIVER_EXPORTED)
            else activity.registerReceiver(receiver, IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED))
        }
        if (device.bondState != BluetoothDevice.BOND_BONDING && !device.createBond()) fail("无法开始配对，请重新开启杯垫配网窗口。")
        return true
    }
    private fun removeBondReceiver() { bondReceiver?.let { runCatching { activity.unregisterReceiver(it) } }; bondReceiver = null }
    private fun result(current: BluetoothGatt, kind: String, uuid: String, status: Int, bytes: ByteArray? = null) = later {
        if (current !== gatt || pending?.kind != kind || pending?.uuid != uuid) return@later
        if (status != BluetoothGatt.GATT_SUCCESS) {
            if (!pairing(status)) fail("蓝牙操作失败（$status），请重新连接。")
        } else finish(JSObject().apply { if (bytes != null) put("value", Base64.encodeToString(bytes, Base64.NO_WRAP)) })
    }
    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(current: BluetoothGatt, status: Int, newState: Int) = later {
            if (current !== gatt) return@later
            if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) { fail("蓝牙已断开，请重连后查询配网结果。"); return@later }
            if (newState == BluetoothProfile.STATE_CONNECTED && !current.discoverServices()) fail("无法读取杯垫蓝牙服务。")
        }
        override fun onServicesDiscovered(current: BluetoothGatt, status: Int) = later {
            if (current !== gatt || pending?.kind != "connect") return@later
            if (status != BluetoothGatt.GATT_SUCCESS || current.getService(serviceId) == null) fail("未找到杯垫蓝牙服务。")
            else finish(JSObject().put("connection", connection))
        }
        @Deprecated("Legacy callback")
        override fun onCharacteristicRead(current: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            if (Build.VERSION.SDK_INT < 33) result(current, "read", characteristic.uuid.toString(), status, characteristic.value)
        }
        override fun onCharacteristicRead(current: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray, status: Int) = result(current, "read", characteristic.uuid.toString(), status, value)
        override fun onCharacteristicWrite(current: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) = result(current, "write", characteristic.uuid.toString(), status)
        override fun onDescriptorWrite(current: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) = result(current, "subscribe", descriptor.characteristic.uuid.toString(), status)
        @Deprecated("Legacy callback")
        override fun onCharacteristicChanged(current: BluetoothGatt, characteristic: BluetoothGattCharacteristic) { if (Build.VERSION.SDK_INT < 33) changed(current, characteristic) }
        override fun onCharacteristicChanged(current: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) = changed(current, characteristic)
    }
    private fun changed(current: BluetoothGatt, characteristic: BluetoothGattCharacteristic) = later {
        if (current === gatt) emit(JSObject().put("type", "value").put("connection", connection).put("uuid", characteristic.uuid.toString()))
    }
    fun background(): Boolean {
        // Android's pairing UI temporarily covers the app; let its in-flight read finish.
        if (selected?.bondState == BluetoothDevice.BOND_BONDING || bondReceiver != null || (pending?.kind == "read" && pending?.uuid == "7d2a0002-7b9c-4e6a-9f21-531bd67a0c10")) return false
        disconnect()
        return true
    }
    fun disconnect(expected: Long? = null) {
        if (expected != null && expected != connection) return
        cancelChoice()
        removeBondReceiver()
        val operation = pending; pending = null
        operation?.let { handler.removeCallbacks(it.timeout); it.invoke.reject("蓝牙操作已停止。") }
        val previous = gatt; gatt = null
        if (previous != null) {
            runCatching { previous.disconnect(); previous.close() }
            emit(JSObject().put("type", "disconnected").put("connection", connection))
        }
    }
}
