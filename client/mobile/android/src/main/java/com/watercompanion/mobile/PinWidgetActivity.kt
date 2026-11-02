package com.watercompanion.mobile

import android.app.Activity
import android.os.Bundle
import android.widget.Toast

/** 桌面长按图标「添加桌面卡片」快捷方式的落地页：弹出系统固定小组件确认框后立即退出。 */
class PinWidgetActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 快捷方式经 LauncherApps 启动，请求确认框由系统桌面接管，本页保持透明无感。
        if (!CompanionWidget.pin(this)) {
            Toast.makeText(this, R.string.widget_pin_unsupported, Toast.LENGTH_SHORT).show()
        }
        finish()
    }
}
