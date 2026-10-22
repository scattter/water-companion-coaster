use crate::model::{CompanionState, Connection, Snapshot};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub struct Frames(Vec<Vec<Image<'static>>>);

impl Frames {
    pub fn load() -> tauri::Result<Self> {
        let files: [[&[u8]; 4]; 4] = [
            [
                include_bytes!("../../public/companion/working-0.png"),
                include_bytes!("../../public/companion/working-1.png"),
                include_bytes!("../../public/companion/working-2.png"),
                include_bytes!("../../public/companion/working-3.png"),
            ],
            [
                include_bytes!("../../public/companion/sleeping-0.png"),
                include_bytes!("../../public/companion/sleeping-1.png"),
                include_bytes!("../../public/companion/sleeping-2.png"),
                include_bytes!("../../public/companion/sleeping-3.png"),
            ],
            [
                include_bytes!("../../public/companion/drinking-0.png"),
                include_bytes!("../../public/companion/drinking-1.png"),
                include_bytes!("../../public/companion/drinking-2.png"),
                include_bytes!("../../public/companion/drinking-3.png"),
            ],
            [
                include_bytes!("../../public/companion/reminding-0.png"),
                include_bytes!("../../public/companion/reminding-1.png"),
                include_bytes!("../../public/companion/reminding-2.png"),
                include_bytes!("../../public/companion/reminding-3.png"),
            ],
        ];
        let mut frames = Vec::new();
        for row in files {
            let mut images = Vec::new();
            for bytes in row {
                let image = decode_png(bytes)
                    .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?;
                images.push(tray_image(image));
            }
            frames.push(images);
        }
        Ok(Self(frames))
    }

    fn image(&self, state: CompanionState, frame: u32) -> Image<'static> {
        let row = match state {
            CompanionState::Working | CompanionState::Idle => 0,
            CompanionState::Sleeping => 1,
            CompanionState::Drinking => 2,
            CompanionState::Reminding => 3,
        };
        self.0[row][frame as usize % 4].clone()
    }
}

fn decode_png(bytes: &[u8]) -> Result<Image<'static>, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| "无法读取水豚帧图。")?;
    let mut pixels = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut pixels)
        .map_err(|_| "无法解码水豚帧图。")?;
    let pixels = &pixels[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => pixels.to_vec(),
        png::ColorType::Rgb => pixels
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => pixels
            .chunks_exact(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        png::ColorType::Grayscale => pixels.iter().flat_map(|p| [*p, *p, *p, 255]).collect(),
        _ => return Err("水豚帧图格式不支持。".into()),
    };
    if info.width == 0 || info.height == 0 {
        return Err("水豚帧图尺寸无效。".into());
    }
    Ok(Image::new_owned(rgba, info.width, info.height))
}

fn tray_image(source: Image<'_>) -> Image<'static> {
    // 预先生成 Retina 尺寸，最近邻采样保留像素边缘，避免每帧解码大图。
    let height = 36;
    let width = (source.width() * height / source.height()).max(1);
    let mut rgba = vec![0; (width * height * 4) as usize];
    for y in 0..height {
        for x in 0..width {
            let source_index = (((y * source.height() / height) * source.width()
                + x * source.width() / width)
                * 4) as usize;
            let target = ((y * width + x) * 4) as usize;
            rgba[target..target + 4]
                .copy_from_slice(&source.rgba()[source_index..source_index + 4]);
        }
    }
    Image::new_owned(rgba, width, height)
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let frames = Frames::load()?;
    let image = frames.image(CompanionState::Idle, 0);
    app.manage(frames);
    let details = MenuItem::with_id(app, "details", "饮水详情", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "陪伴设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出饮水陪伴", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&details, &settings, &quit])?;
    TrayIconBuilder::with_id("companion")
        .icon(image)
        .icon_as_template(false)
        .title("— ml")
        .tooltip("饮水陪伴")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "details" => {
                let _ = crate::show_panel(app, "dashboard");
            }
            "settings" => {
                let _ = crate::show_panel(app, "settings");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(panel) = app.get_webview_window("panel") {
                    if panel.is_visible().unwrap_or(false) {
                        let _ = panel.hide();
                    } else {
                        let _ = crate::show_panel(app, "dashboard");
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}

pub fn render(app: &AppHandle, snapshot: &Snapshot, previous: Option<&Snapshot>) {
    let Some(tray) = app.tray_by_id("companion") else {
        return;
    };
    if previous.is_none_or(|old| old.state != snapshot.state || old.frame != snapshot.frame) {
        let frame = app.state::<Frames>().image(snapshot.state, snapshot.frame);
        let _ = tray.set_icon(Some(frame));
    }
    let title = |value: &Snapshot| {
        let amount = value
            .dashboard
            .as_ref()
            .map(|data| format!("{:.0}", data.totals.drink_ml))
            .unwrap_or("—".into());
        let marker = if value.connection == Connection::Offline {
            "· "
        } else {
            ""
        };
        format!("{marker}{amount} ml")
    };
    if previous.is_none_or(|old| title(old) != title(snapshot)) {
        let _ = tray.set_title(Some(title(snapshot)));
    }
    if previous.is_none_or(|old| {
        old.connection != snapshot.connection || old.last_synced_at != snapshot.last_synced_at
    }) {
        let text = match snapshot.connection {
            Connection::Online => "饮水陪伴 · 已同步",
            Connection::Offline => "饮水陪伴 · 连接中断，显示上次同步数据",
            Connection::Connecting => "饮水陪伴 · 正在连接",
            Connection::SignedOut => "饮水陪伴 · 请登录",
            Connection::Unconfigured => "饮水陪伴 · 请配置服务器",
        };
        let _ = tray.set_tooltip(Some(text));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_menu_frames_share_dimensions_and_retain_transparency() {
        let frames = Frames::load().unwrap();
        let size = (frames.0[0][0].width(), frames.0[0][0].height());
        assert_eq!(size, (72, 36));
        for row in &frames.0 {
            for frame in row {
                assert_eq!((frame.width(), frame.height()), size);
                assert!(frame.rgba().chunks_exact(4).any(|pixel| pixel[3] == 0));
                assert!(frame.rgba().chunks_exact(4).any(|pixel| pixel[3] > 0));
            }
            assert!(row.windows(2).any(|pair| pair[0].rgba() != pair[1].rgba()));
        }
    }
}
