# 杯垫工厂与用户说明

版本日期：2026年10月24日。按当前 0.7.2 固件和网页流程整理。

| 文档 | 可编辑正文 | 打印版 |
| --- | --- | --- |
| 工厂初始化说明 | [工厂操作正文](工厂初始化说明.md) | [5 页 PDF](../../output/pdf/水伴杯垫工厂初始化说明.pdf) |
| 用户使用说明书 | [用户操作正文](用户使用说明书.md) | [6 页图文 PDF](../../output/pdf/水伴杯垫用户使用说明书.pdf) |

用户入口为 [水伴网站](https://49.235.85.227/)，二维码也编码该完整 HTTPS 地址。

用户说明书面向普通用户，介绍接电、注册、蓝牙连接、选择 Wi-Fi、记住空杯、饮水记录、换网络和常见问题。出厂标定只放在工厂说明中。

工厂说明包含 Arduino 设置、串口命令、逐台重量复核表及解绑交付流程。表中的误差限值应由负责人在整机验证后填写，没有预设或承诺未验证的产品精度。

## 配图来源

- `assets/login-live.png` 与 `assets/login-panel.png`：2026年10月24日从正式网址截取的未登录页面，没有使用账号或填写凭证。
- `assets/prepare.png`、`assets/pairing.png`、`assets/wifi-form.png`、`assets/empty-cup.png`、`assets/calibration.png`：依据当前流程绘制的操作示意；页面按钮沿用项目文案，外观、重量、网络名及配对码均不作为真实产品或真实测量值。
- `assets/daily-use.png`：使用内置 imagegen 生成的拿杯、喝水、放回示意。完整提示词见 [图片生成说明](图片生成说明.txt)。
- `assets/website-qr.png`：完整网址二维码，保留四模块留白边界。

## 核对边界

正文依据 `firmware/README.md`、`docs/factory-provisioning.md`、`coaster.c`、`storage.c` 和网页现有按钮文案整理。正式网址已检查可访问；配网与空杯图为示意，不代表完成了真机配对、生产验证或称重精度验收。交付前仍应按工厂说明操作真实整机。

浏览器兼容性参考 [Chrome 官方说明](https://developer.chrome.com/docs/capabilities/bluetooth) 和 [Edge 官方说明](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/DefaultWebBluetoothGuardSetting)。
