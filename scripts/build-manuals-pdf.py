# -*- coding: utf-8 -*-
"""从 docs/manuals/*.md 重新生成两份说明书 PDF（喝吧喝吧品牌版）。
沿用旧版交付形态：无独立封面，每页页眉放品牌标 + 文档类型，正文流式排版。
配色取自产品设计系统：品牌蓝 #3a63d2、墨色 #23262e、灰 #6d7482、分隔线 #e3e7ee。"""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, Image, KeepTogether,
                                PageTemplate, Paragraph, Spacer, Table,
                                TableStyle, CondPageBreak)

ROOT = Path("/Users/zhangke/code/self/water-companion-coaster")
MANUALS = ROOT / "docs/manuals"
OUT = ROOT / "output/pdf"
FONT_DIR = Path("/tmp/unifont-dl/fonts")
MARK = Path("/tmp/unifont-dl/mark-512.png")

# ━━ 品牌配色（来自产品设计系统，与 web 主题一致） ━━
ACCENT = colors.HexColor("#3a63d2")
ACCENT_SOFT = colors.HexColor("#e8eefa")
TEXT_PRIMARY = colors.HexColor("#23262e")
TEXT_MUTED = colors.HexColor("#6d7482")
LINE = colors.HexColor("#e3e7ee")
BG_SURFACE = colors.HexColor("#f5f7fa")

pdfmetrics.registerFont(TTFont("NotoSC", str(FONT_DIR / "NotoSansSC-550.ttf")))
pdfmetrics.registerFont(TTFont("NotoSC-Bold", str(FONT_DIR / "NotoSansSC-600.ttf")))

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

S = {
    "doc_title": ParagraphStyle("doc_title", fontName="NotoSC-Bold", fontSize=20, leading=28,
                                textColor=TEXT_PRIMARY, spaceAfter=2),
    "doc_meta": ParagraphStyle("doc_meta", fontName="NotoSC", fontSize=9, leading=14,
                               textColor=TEXT_MUTED, spaceAfter=10),
    "h2": ParagraphStyle("h2", fontName="NotoSC-Bold", fontSize=14.5, leading=20,
                         textColor=ACCENT, spaceBefore=16, spaceAfter=7),
    "h3": ParagraphStyle("h3", fontName="NotoSC-Bold", fontSize=11.5, leading=17,
                         textColor=TEXT_PRIMARY, spaceBefore=11, spaceAfter=5),
    "body": ParagraphStyle("body", fontName="NotoSC", fontSize=10, leading=17,
                           textColor=TEXT_PRIMARY, spaceAfter=6, wordWrap="CJK"),
    "caption": ParagraphStyle("caption", fontName="NotoSC", fontSize=8.5, leading=12.5,
                              textColor=TEXT_MUTED, alignment=1, spaceBefore=3, spaceAfter=8,
                              wordWrap="CJK"),
    "cell": ParagraphStyle("cell", fontName="NotoSC", fontSize=9, leading=14,
                           textColor=TEXT_PRIMARY, wordWrap="CJK"),
    "cell_head": ParagraphStyle("cell_head", fontName="NotoSC-Bold", fontSize=9.5, leading=14,
                                textColor=colors.white, wordWrap="CJK"),
    "code": ParagraphStyle("code", fontName="Courier", fontSize=9, leading=14,
                           textColor=TEXT_PRIMARY),
    "url": ParagraphStyle("url", fontName="NotoSC-Bold", fontSize=11, leading=17,
                          textColor=ACCENT),
}


def para(text, style="body"):
    text = text.replace("**", "<b>", 1)
    while "**" in text:
        text = text.replace("**", "</b>", 1) if "</b>" in text or text.count("<b>") > text.count("</b>") else text.replace("**", "<b>", 1)
    return Paragraph(text, S[style])


def image_block(path, caption, max_w=None):
    max_w = max_w or CONTENT_W * 0.82
    from PIL import Image as PILImage
    w, h = PILImage.open(path).size
    scale = min(max_w / w, (90 * mm) / h, 1.6)
    img = Image(str(path), width=w * scale, height=h * scale)
    return KeepTogether([Spacer(1, 2), img, Paragraph(caption, S["caption"])])


def make_table(header, rows, widths):
    data = [[Paragraph(cell, S["cell_head"]) for cell in header]]
    for row in rows:
        data.append([Paragraph(c.replace("<br>", "<br/>"), S["cell"]) for c in row])
    t = Table(data, colWidths=widths, hAlign="CENTER", repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), ACCENT),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("LINEBELOW", (0, 0), (-1, -2), 0.5, LINE),
        ("BOX", (0, 0), (-1, -1), 0.75, LINE),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), BG_SURFACE))
    t.setStyle(TableStyle(style))
    return KeepTogether([Spacer(1, 3), t, Spacer(1, 8)])


def code_block(lines):
    inner = [Paragraph(line.replace("&", "&amp;").replace("<", "&lt;"), S["code"]) for line in lines]
    t = Table([[inner]], colWidths=[CONTENT_W * 0.7], hAlign="CENTER")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BG_SURFACE),
        ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("BOX", (0, 0), (-1, -1), 0.75, LINE),
    ]))
    return KeepTogether([Spacer(1, 3), t, Spacer(1, 8)])


def url_qr_block(url_text, caption, qr_path):
    from PIL import Image as PILImage
    w, h = PILImage.open(qr_path).size
    qr = Image(str(qr_path), width=30 * mm, height=30 * mm * h / w)
    left = [Paragraph("打开喝吧喝吧使用页面", S["h3"]),
            Paragraph(url_text, S["url"]),
            Paragraph(caption, S["body"])]
    t = Table([[left, qr]], colWidths=[CONTENT_W * 0.68, CONTENT_W * 0.32], hAlign="CENTER")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (0, 0), (-1, -1), ACCENT_SOFT),
        ("TOPPADDING", (0, 0), (-1, -1), 10), ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("BOX", (0, 0), (-1, -1), 0.75, LINE),
    ]))
    return KeepTogether([Spacer(1, 3), t, Spacer(1, 8)])


def header_footer(doc_kind):
    label = "用户使用指南" if doc_kind == "user" else "工厂操作资料"
    doc_name = "用户使用说明书" if doc_kind == "user" else "工厂初始化说明"

    def draw(canvas, doc):
        canvas.saveState()
        # 页眉
        y = PAGE_H - MARGIN + 4 * mm
        canvas.drawImage(str(MARK), MARGIN, y - 4 * mm, 7 * mm, 7 * mm, mask="auto")
        canvas.setFont("NotoSC-Bold", 9)
        canvas.setFillColor(TEXT_PRIMARY)
        canvas.drawString(MARGIN + 10 * mm, y - 1.6 * mm, "喝吧喝吧")
        canvas.setFont("NotoSC", 9)
        canvas.setFillColor(TEXT_MUTED)
        canvas.drawString(MARGIN + 10 * mm + canvas.stringWidth("喝吧喝吧", "NotoSC-Bold", 9) + 4 * mm,
                          y - 1.6 * mm, f"杯垫 · {label}")
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.75)
        canvas.line(MARGIN, y - 6 * mm, PAGE_W - MARGIN, y - 6 * mm)
        # 页脚
        canvas.setFont("NotoSC", 8)
        canvas.setFillColor(TEXT_MUTED)
        canvas.drawString(MARGIN, 12 * mm, f"喝吧喝吧杯垫{doc_name}")
        canvas.drawRightString(PAGE_W - MARGIN, 12 * mm, f"第 {canvas.getPageNumber()} 页")
        canvas.restoreState()
    return draw


def build(filename, kind, story):
    doc = BaseDocTemplate(str(OUT / filename), pagesize=A4,
                          leftMargin=MARGIN, rightMargin=MARGIN,
                          topMargin=MARGIN + 8 * mm, bottomMargin=MARGIN,
                          title=f"喝吧喝吧杯垫{S_DOC_TITLE[kind]}",
                          author="喝吧喝吧", creator="喝吧喝吧",
                          subject="喝吧喝吧智能称重杯垫说明文档")
    frame = Frame(MARGIN, MARGIN, CONTENT_W, PAGE_H - 2 * MARGIN - 8 * mm, id="main")
    doc.addPageTemplates([PageTemplate(id="page", frames=[frame], onPage=header_footer(kind))])
    doc.build(story)


S_DOC_TITLE = {"user": "用户使用说明书", "factory": "工厂初始化说明"}


# ══════════ 用户使用说明书 ══════════
def user_manual():
    A = MANUALS / "assets"
    story = [
        Paragraph("喝吧喝吧杯垫用户使用说明书", S["doc_title"]),
        Paragraph("版本日期：2026年10月24日", S["doc_meta"]),
        para("先连接网络，再让杯垫记住你的空杯。以后每次拿起杯子喝水、放回杯垫，它会根据重量变化估算饮水量。"),
        image_block(A / "prepare.png", "准备示意：杯垫放在坚硬、平稳的桌面上。外观和接口位置以收到的实物为准。"),
        url_qr_block("https://49.235.85.227/",
                     "扫描右侧二维码，或在浏览器地址栏输入上方网址。请保留 https://。", A / "website-qr.png"),
        CondPageBreak(PAGE_H * 0.25),
        Paragraph("首次连接用什么浏览器", S["h3"]),
        para("建议使用<b>电脑上的 Chrome 或 Edge</b>，也可使用<b>安卓手机上的 Chrome</b>。打开蓝牙，并允许浏览器使用蓝牙。电脑本身也需要具备蓝牙功能。"),
        para("iPhone 或 iPad 用户：先借助上述电脑或安卓手机，用<b>你自己的账号</b>完成首次连接。绑定成功后，可在 iPhone 的 Safari 中登录同一网址查看记录。"),
        para("如果扫码后在微信等应用内打开，请复制网址到支持的浏览器。准备家中普通的 <b>2.4 GHz Wi-Fi</b> 及密码。"),
        Paragraph("注册账号并连接杯垫", S["h2"]),
        para("杯垫接通电源后，手机或电脑也要能正常上网。首次使用不需要填写设备编号，也不需要准备砝码。"),
        Paragraph("1  注册或登录喝吧喝吧", S["h3"]),
        para("点击“还没有账号？注册”，设置自己的账号和密码，再点击“注册并登录”。已有账号直接登录。请妥善保存账号和密码。账号可使用中文、字母、数字或下划线；密码至少 8 位。"),
        image_block(A / "login-panel.png", "登录页实图"),
        Paragraph("2  选择你的杯垫", S["h3"]),
        para("登录后点击“添加杯垫”，再点击“选择杯垫”。在系统列表中选择 <b>Water-Coaster</b>。"),
        image_block(A / "pairing.png", "连接示意：123456 只是示例，请输入自己杯垫屏幕上的六位配对码。"),
        para("找不到设备时，等杯垫启动完成，再长按 <b>BOOT 配网键 3 秒</b>。配网窗口持续约 10 分钟；不要按住 BOOT 再接通电源，也不用先去系统蓝牙列表配对。屏幕默认熄灭，需要查看配对码时短按侧边 BOOT 键，点亮 15 秒后自动熄屏。"),
        Paragraph("选择家里的 Wi-Fi", S["h2"]),
        para("蓝牙用来把网络信息交给杯垫。之后杯垫会自己连接 Wi-Fi，日常不需要一直连着手机蓝牙。"),
        image_block(A / "wifi-form.png", "配网页面示意。网络名与显示样式以实际页面为准。"),
        Paragraph("3  选择网络并输入密码", S["h3"]),
        para("在“选择 2.4 GHz Wi-Fi”中选自己的网络，填写 Wi-Fi 密码，再点击<b>“配网并绑定杯垫”</b>。这里填写的是路由器密码，不是喝吧喝吧账号密码。"),
        para("没有找到网络时，先把杯垫放近路由器，再点“重新扫描”。确认路由器已开启 2.4 GHz；隐藏网络可点击“隐藏网络？手动输入”。"),
        Paragraph("4  等待页面确认完成", S["h3"]),
        para("看到<b>“杯垫已联网并完成绑定”</b>后，再进行下一步。过程中保持杯垫供电、手机或电脑联网。"),
        para("若提示超时或蓝牙断开，先点<b>“继续查询配网结果”</b>。只有“蓝牙已连接”或“正在连接 Wi-Fi”，还不算完成。"),
        para("需要网页认证的酒店网络、企业认证网络暂不支持。一个账号同时绑定一台杯垫。"),
        CondPageBreak(PAGE_H * 0.25),
        Paragraph("让杯垫记住你的空杯", S["h2"]),
        para("这一步告诉杯垫“杯子本身有多重”。首次使用、换杯子，或改变杯盖和吸管等配置时，重新做一次即可。"),
        image_block(A / "empty-cup.png", "空杯设置示意。140.0 g 只是示例，你不需要填写或计算重量。"),
        Paragraph("5  放好空杯后点击记住这个杯子", S["h3"]),
        para("把常用杯子里的水倒空。平时一起放在杯垫上的杯盖、吸管等配件，也按日常状态放好。擦干杯底，再放到杯垫中央。"),
        para("松手，静置至少 <b>3 秒</b>。在网站打开<b>“杯垫设置”</b>，找到“日常空杯设置”，点击<b>“记住这个杯子”</b>。首页出现“设置空杯”时，也可以从那里进入。"),
        para("保持空杯不动，等到<b>“空杯设置成功，可以加水使用了。”</b>再拿起杯子加水。按钮显示“正在等待设置结果…”时，先继续等待或点击“查询设置结果”。"),
        Paragraph("加水后先放稳一次", S["h3"]),
        para("装好水，把杯子放回杯垫，松手并静置约 3 秒，再开始正常喝水。"),
        para("<b>不要带着水设置空杯。</b>普通加水、喝水或重新通电后，不用每天重复设置。"),
        Paragraph("每天喝水这样记录", S["h2"]),
        para("保持杯垫供电，杯子放在承重区域中央。日常只需要正常拿起、喝水、放回。"),
        image_block(A / "daily-use.png", "日常使用示意：拿起时完全离开杯垫，放回时松开手。图中杯垫外观仅作示意。"),
        make_table(["拿起来", "喝水", "放回去"],
                   [["杯底完全离开杯垫。", "像平时一样喝水。", "放回中央，松手，静置约 3 秒。"]],
                   [CONTENT_W * 0.3, CONTENT_W * 0.32, CONTENT_W * 0.38]),
        Paragraph("在网站查看饮水记录", S["h3"]),
        para("登录同一个账号，查看“今日饮水量”“饮水次数”和“饮水记录”；切换“查看日期”可查看往日记录。误把倒掉的水记成饮水时，可在对应记录旁点击“撤销”。"),
        Paragraph("这几种情况会影响记录", S["h3"]),
        para("· 用吸管喝水但杯子一直没有拿起，可能不会生成饮水记录。很小的重量变化也可能不记。"),
        para("· 喝完后先放回杯垫、等读数稳定，再拿去加水。喝水和加水连着做，只能看到最后的净变化。"),
        para("· 倒水也会让重量变轻，杯垫无法分辨是喝掉还是倒掉。"),
        para("清水约按 1 g 变化换算为 1 mL，属于估算。网页关闭后杯垫仍会工作；断网时先保存记录，恢复网络后再同步。断网期间尽量保持供电，避免部分记录的日期无法确认。"),
        CondPageBreak(PAGE_H * 0.25),
        Paragraph("更换网络和常见问题", S["h2"]),
        para("换路由器或 Wi-Fi 密码时，重新配网即可；使用同一个账号，不需要先解绑。"),
        Paragraph("更换 Wi-Fi", S["h3"]),
        para("1. 杯垫启动后，长按 BOOT 配网键 3 秒。"),
        para("2. 在网站打开“杯垫设置”，找到“为我的杯垫更换 Wi-Fi”，点击“选择杯垫”。"),
        para("3. 选择新网络，填写密码，点击“保存新的 Wi-Fi”，等页面确认成功。"),
        make_table(["遇到的情况", "可以这样处理"], [
            ["搜索不到杯垫", "打开蓝牙并允许浏览器使用；靠近杯垫；重新长按配网键。首次配网请使用第 1 页推荐的浏览器。"],
            ["显示离线或未同步", "检查供电及路由器网络；保持杯垫联网并稍候。换过 Wi-Fi 密码时，按上方步骤重新配网。"],
            ["记住这个杯子无法点击", "先等杯垫“云端在线”。提示尚未完成出厂标定时，联系购买渠道或售后，无需自行找砝码。"],
            ["喝水后没有新记录", "确认已设置空杯；杯子要完全拿起，放回后松手等稳定；同时检查杯垫是否在线。"],
            ["屏幕不亮或自动变黑", "屏幕默认熄灭，短按侧边 BOOT 键点亮，15 秒后自动熄屏；再次按下重新计时。拿放杯子和加水不会亮屏，熄屏时仍继续称重与上传。"],
            ["提示已属于其他账号", "请原主人登录，在“杯垫设置”中点击“解绑我的杯垫”并确认。新主人绑定后重新设置空杯。"],
        ], [CONTENT_W * 0.26, CONTENT_W * 0.74]),
        para("日常保持杯垫和杯底干燥，用软布擦拭；不要浸水、冲洗、用手压住承重盘或放置重物。遇到异常，联系购买渠道并提供屏幕提示或页面截图。"),
        para("浏览器说明参考：Chrome 网页蓝牙说明、Edge 网页蓝牙支持说明（详见在线帮助）。"),
    ]
    build("喝吧喝吧杯垫用户使用说明书.pdf", "user", story)


# ══════════ 工厂初始化说明 ══════════
def factory_manual():
    A = MANUALS / "assets"
    story = [
        Paragraph("喝吧喝吧杯垫工厂初始化说明", S["doc_title"]),
        Paragraph("版本日期：2026年10月24日", S["doc_meta"]),
        Paragraph("工厂初始化与交付流程", S["h2"]),
        para("每台杯垫在整机装配完成后，独立烧录、标定、复核并记录结果。通用固件可以共用，零点和重量比例必须按实物逐台生成。"),
        para("<b>适用范围</b>：微雪 ESP32-S3-LCD-1.47B、TAL220B 2 kg 传感器、支持 3.3 V 的单 VCC HX711；固件 0.7.2。其他硬件版本应先核对引脚、供电与分区。"),
        image_block(A / "calibration.png", "重量初始化顺序。零点和比例自动保存到本机 Flash，不依赖工厂联网。"),
        Paragraph("开工前准备", S["h3"]),
        para("准备已装配完成的整机、可传数据的 Type-C 线、电脑、Arduino IDE、500 g 标定砝码，以及 100 g 和 1 kg 等复核砝码。记录砝码编号与质量依据，不用瓶装水标称容量代替已知质量。"),
        make_table(["检查项", "要求"], [
            ["机械结构", "螺丝、上盘、外壳处于最终装配状态；受力梁可正常形变；上盘不碰固定外壳，线缆不拉扯承重部分。"],
            ["HX711 接线", "VCC → 3V3；GND → GND；DOUT/DT → GPIO2；SCK/CLK → GPIO4。当前单 VCC 模块不接 5 V。"],
            ["采样与量程", "HX711 A 通道，128 倍增益，10 SPS。2 kg 机械载荷包括上盘、杯子和水；去零不会增加机械量程。"],
            ["操作台", "平稳、坚硬、无碰触或明显振动。每次移放物品后松手并静置至少 3 秒。"],
        ], [CONTENT_W * 0.2, CONTENT_W * 0.8]),
        para("生产放行前由负责人确定重量误差、重复性、偏载和回零限值，并填入第 4 页。当前项目没有已完成整机验证的精度承诺，不将软件测试结果当成出厂验收。"),
        Paragraph("烧录与启动检查", S["h2"]),
        para("先上传统一固件，再对该台整机进行标定。保留工程分区，禁止把其他设备含标定值、身份或凭证的整片 Flash 镜像复制过来。"),
        para("Arduino IDE 打开 firmware/water_companion/water_companion.ino。复制工程时保留整个 water_companion 文件夹，尤其是同级 partitions.csv。"),
        make_table(["Arduino 设置项", "选择"], [
            ["开发板包", "esp32 by Espressif Systems 3.3.11"],
            ["Board", "ESP32S3 Dev Module"],
            ["USB Mode / USB CDC On Boot", "Hardware CDC and JTAG / Enabled"],
            ["Upload Mode / CPU Frequency", "UART0 / Hardware CDC / 240MHz (WiFi)"],
            ["Flash Mode / Flash Size", "QIO 80MHz / 16MB (128Mb)"],
            ["PSRAM", "OPI PSRAM"],
            ["Partition Scheme", "16M Flash (3MB APP/9.9MB FATFS)；实际使用工程 partitions.csv"],
            ["Erase All Flash Before Sketch Upload", "Disabled"],
            ["Core Debug Level", "None"],
        ], [CONTENT_W * 0.42, CONTENT_W * 0.58]),
        para("选择该台开发板对应串口，验证通过后上传。串口监视器选择 <b>115200</b> 和<b>新行 New Line</b>；重启后端口有变化时重新选择。"),
        code_block(['{"cmd":"status"}', '{"cmd":"watch","enabled":true}']),
        para("确认固件版本为 0.7.2、启动日志到达 boot[ready]，raw 有连续读数且随加载改变。新机尚未标定时 weightGrams 为 null、calibrated 为 false，属于预期。"),
        para("启动失败时发送 {\"cmd\":\"diagnostics\"} 并保存日志；先检查 PSRAM、分区及接线，不通过擦除 Flash 反复试错。"),
        Paragraph("逐台执行重量标定", S["h2"]),
        para("标定过程无需登录网站。以下命令逐条发送；每一步收到 ok 为 true 后再继续，若失败先排除原因。"),
        Paragraph("1  整机空载归零", S["h3"]),
        para("移走杯子、砝码和杂物，保留承重盘。松手并静置至少 3 秒。"),
        code_block(['{"cmd":"tare"}']),
        para("成功后零点已保存。未标定的新机会提示放上已知重量物品。不要把装着杯子的状态当成整机空载。"),
        Paragraph("2  使用已知质量计算重量比例", S["h3"]),
        para("将 500 g 砝码放在承重盘中央，松手并静置至少 3 秒。"),
        code_block(['{"cmd":"calibrate","grams":500}']),
        para("参数必须等于砝码实际已知质量。固件接受 50–2000 g，但加载时仍须计入上盘自重，不能超出传感器机械量程。"),
        para("收到 ok 为 true 后，零点和 counts_per_gram 已保存到 settings 分区；无需另发保存命令。calibrate 会清除旧空杯设置，工厂最终交付时不预设用户空杯。"),
        Paragraph("3  查看结果并准备复核", S["h3"]),
        code_block(['{"cmd":"status"}']),
        para("确认 calibrated 为 true，并观察 weightGrams。移走砝码，再换其他已知重量按第 4 页复核。"),
        para("<b>不要用 stable 字段作为出厂标定门槛。</b>未设置用户空杯时它会保持 false，且可能提示“请先登记空杯重量”。标定命令另行检查原始采样稳定性，应以成功回执和重量复核结果判断。"),
        para("换算关系为（原始读数 - 零点）÷ counts_per_gram。单点标定成功不代表全量程、重复性和偏载都已通过。现有 tare 只更新零点，保留原比例和空杯；更换传感器或改变承重结构后应重做完整标定与复核。"),
        CondPageBreak(PAGE_H * 0.3),
        Paragraph("复核与逐台记录", S["h2"]),
        para("以下记录留存到对应整机。没有约定限值或存在任一超限项目时，不填写合格，不用反复标定掩盖机械或电气问题。"),
        para("工单／序列号：________________　　操作员：____________"),
        para("日期：________________　　砝码编号：________________"),
        para("已批准限值：重量误差 ±______ g；回零 ±______ g；"),
        para("同一砝码重复取放极差 ≤______ g；偏载读数极差 ≤______ g。"),
        make_table(["复核项目", "操作", "实测与判定"], [
            ["空载回零", "移走砝码，静置后记录。", "______ g<br>合格 / 不合格"],
            ["100 g 复核", "中央放置，记录读数减实际质量的误差。", "读数 ______ g<br>误差 ______ g"],
            ["500 g 复核", "重新取放标定砝码并记录。", "读数 ______ g<br>误差 ______ g"],
            ["1 kg 复核", "确认未超载，中央放置并记录。", "读数 ______ g<br>误差 ______ g"],
            ["重复性", "同一砝码中央重复取放 5 次；记录最大读数减最小读数。", "最大 ______ g<br>最小 ______ g<br>极差 ______ g"],
            ["偏载", "同一砝码放中心及承重区域四周，分别静置记录，不能悬空。", "中心 ______ g<br>前后 ______ / ______<br>左右 ______ / ______"],
            ["断电重启", "完全断电再上电；确认 calibrated 为 true，再查空载和 500 g。", "空载 ______ g<br>500 g ______ g"],
        ], [CONTENT_W * 0.16, CONTENT_W * 0.44, CONTENT_W * 0.4]),
        para("复核期间可开启 watch 连续查看；结束后关闭。额外记录持续漂移、回零困难、碰外壳或线缆拉扯等异常。"),
        code_block(['{"cmd":"watch","enabled":false}']),
        para("最终判定：合格 / 不合格　　复核人：____________"),
        para("异常与处理：________________________________________________"),
        Paragraph("联网测试与出厂交付", S["h2"]),
        para("工厂完成重量标定；最终用户用自己的账号配网、绑定并设置空杯。设备编号和独立凭证由服务端首次注册时生成。"),
        Paragraph("按出厂检验要求执行联网与记录测试", S["h3"]),
        para("1. 使用测试账号打开 https://49.235.85.227/，按用户说明书完成蓝牙配网。测试网络应为普通 2.4 GHz Wi-Fi。"),
        para("2. 确认页面完成绑定、设备云端在线。需要验证饮水记录时，登记测试空杯，加水放稳，再拿起、减少已知水量、放回，检查记录。"),
        para("3. 测试完成，在“杯垫设置”中由原测试账号执行“解绑我的杯垫”并确认，保持设备联网直至同步完成。"),
        para("4. 复查网页已解绑，设备 status 中 bound 为 false、emptyCupGrams 为 0、calibrated 为 true。重启复核；未同步完成时不要交付。"),
        para("测试账号保留自己的测试历史。已登记的编号和凭证不应复制或删除；产线 Wi-Fi 可能继续保存，用户可长按配网键换成自己的网络。不要通过擦除 Flash 来“恢复出厂”，否则会丢失标定。"),
        Paragraph("交付前逐项确认", S["h3"]),
        para("□ 固件版本、启动与接线检查通过。"),
        para("□ 零点和重量比例逐台保存，复核表完整且全部符合已批准限值。"),
        para("□ 完全断电重启后标定和重量读数仍正常。"),
        para("□ 测试账号已解绑，设备已同步，用户空杯未预设。"),
        para("□ 产品随附用户说明书，网址和二维码对应当前正式服务。"),
        para("□ 未把凭证、Wi-Fi 密码或蓝牙配对码打印进公开记录。"),
        Paragraph("常见失败如何处理", S["h3"]),
        make_table(["提示或现象", "处理"], [
            ["传感器未就绪", "核对 3.3 V 供电、共地、GPIO2/4、桥路线序和连续采样，静置后重试。"],
            ["零点或砝码采样不稳定", "检查桌面振动、手部触碰、上盘碰壳、线缆拉力和砝码是否放稳。"],
            ["配置写入失败", "停止该台放行，保留设备数据及日志；检查 Flash 和分区配置。"],
            ["只在某位置或某重量偏差大", "检查受力与机械装配；修复后重新标定并完整复核，不能只看 500 g 点。"],
        ], [CONTENT_W * 0.3, CONTENT_W * 0.7]),
        para("依据：firmware/README.md、docs/factory-provisioning.md、coaster.c 与 storage.c。配网、断电恢复和实际精度仍须按本说明逐台真机验收。"),
    ]
    build("喝吧喝吧杯垫工厂初始化说明.pdf", "factory", story)


user_manual()
factory_manual()
print("两份 PDF 已生成")
