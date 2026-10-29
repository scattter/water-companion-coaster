use crate::model::{Character, CompanionState, Connection, Snapshot};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub struct Frames {
    frames: Vec<Vec<Image<'static>>>,
    characters: Vec<(Character, Image<'static>)>,
}

#[cfg(target_os = "windows")]
struct AmountIcon {
    frame: Image<'static>,
    title: String,
    light: bool,
    generation: u64,
}

#[cfg(target_os = "windows")]
fn render_amount(app: &AppHandle, title: &str, animate: bool) {
    use crate::{amount_icon, platform};
    use std::{
        sync::Mutex,
        time::{Duration, Instant},
    };

    let light = platform::light_taskbar();
    let target = amount_icon::image(title, light);
    let (before, generation, animate) = {
        let state = app.state::<Mutex<AmountIcon>>();
        let mut current = state.lock().unwrap();
        if current.title == title && current.light == light {
            return;
        }
        let animate = animate && current.light == light && platform::animate_taskbar();
        current.generation += 1;
        current.title = title.into();
        current.light = light;
        let before = current.frame.clone();
        if !animate {
            current.frame = target.clone();
        }
        (before, current.generation, animate)
    };
    if !animate {
        if let Some(tray) = app.tray_by_id("amount") {
            let _ = tray.set_icon(Some(target));
        }
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        loop {
            if app.state::<Mutex<AmountIcon>>().lock().unwrap().generation != generation {
                break;
            }
            let progress = started.elapsed().as_secs_f64().min(1.0);
            let frame = amount_icon::slide(&before, &target, amount_icon::ease(progress));
            let handle = app.clone();
            if app
                .run_on_main_thread(move || {
                    let state = handle.state::<Mutex<AmountIcon>>();
                    let mut current = state.lock().unwrap();
                    // 丢弃被后续同步替代的动画帧，防止旧数字在退出账号后重新出现。
                    if current.generation != generation {
                        return;
                    }
                    current.frame = frame.clone();
                    drop(current);
                    if let Some(tray) = handle.tray_by_id("amount") {
                        let _ = tray.set_icon(Some(frame));
                    }
                })
                .is_err()
            {
                break;
            }
            if progress >= 1.0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(16)).await;
        }
    });
}

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
                images.push(tray_image(image, false));
            }
            frames.push(images);
        }
        let files: [(Character, &[u8]); 5] = [
            (
                Character::Robot,
                include_bytes!("../../public/companion/characters/robot.png"),
            ),
            (
                Character::Cat,
                include_bytes!("../../public/companion/characters/cat.png"),
            ),
            (
                Character::Dog,
                include_bytes!("../../public/companion/characters/dog.png"),
            ),
            (
                Character::Girl,
                include_bytes!("../../public/companion/characters/girl.png"),
            ),
            (
                Character::Boy,
                include_bytes!("../../public/companion/characters/boy.png"),
            ),
        ];
        let mut characters = Vec::new();
        for (character, bytes) in files {
            let image = decode_png(bytes)
                .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?;
            characters.push((character, tray_image(image, character != Character::Robot)));
        }
        Ok(Self { frames, characters })
    }

    fn image(&self, character: Character, state: CompanionState, frame: u32) -> Image<'static> {
        if let Some((_, image)) = self.characters.iter().find(|(id, _)| *id == character) {
            return image.clone();
        }
        let row = match state {
            CompanionState::Working | CompanionState::Idle => 0,
            CompanionState::Sleeping => 1,
            CompanionState::Drinking => 2,
            CompanionState::Reminding => 3,
        };
        self.frames[row][frame as usize % 4].clone()
    }
}

fn decode_png(bytes: &[u8]) -> Result<Image<'static>, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| "无法读取陪伴图像。")?;
    let mut pixels = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut pixels)
        .map_err(|_| "无法解码陪伴图像。")?;
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
        _ => return Err("陪伴图像格式不支持。".into()),
    };
    if info.width == 0 || info.height == 0 {
        return Err("陪伴图像尺寸无效。".into());
    }
    Ok(Image::new_owned(rgba, info.width, info.height))
}

fn tray_image(source: Image<'_>, crop: bool) -> Image<'static> {
    // 预先生成 Retina 尺寸，最近邻采样保留像素边缘，避免每帧解码大图。
    let height = 36;
    // 场景图与前端 2:1、center 54% 取景一致；机器人保留完整全身。
    let source_height = if crop {
        source.width() / 2
    } else {
        source.height()
    };
    let top = (source.height() - source_height) * 54 / 100;
    let width = (source.width() * height / source_height).max(1);
    let mut rgba = vec![0; (width * height * 4) as usize];
    for y in 0..height {
        for x in 0..width {
            let source_index = (((top + y * source_height / height) * source.width()
                + x * source.width() / width)
                * 4) as usize;
            let target = ((y * width + x) * 4) as usize;
            rgba[target..target + 4]
                .copy_from_slice(&source.rgba()[source_index..source_index + 4]);
        }
    }
    #[cfg(target_os = "windows")]
    {
        let side = width.max(height);
        let mut square = vec![0; (side * side * 4) as usize];
        for y in 0..height {
            let target = (((side - height) / 2 + y) * side * 4) as usize;
            let source = (y * width * 4) as usize;
            square[target..target + (width * 4) as usize]
                .copy_from_slice(&rgba[source..source + (width * 4) as usize]);
        }
        return Image::new_owned(square, side, side);
    }
    #[cfg(not(target_os = "windows"))]
    Image::new_owned(rgba, width, height)
}

fn on_tray_event(tray: &TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        #[cfg(target_os = "windows")]
        if crate::platform::consume_tray_blur() {
            return;
        }
        let app = tray.app_handle();
        if let Some(panel) = app.get_webview_window("panel") {
            if panel.is_visible().unwrap_or(false) {
                let _ = panel.hide();
            } else {
                let _ = crate::show_panel(app, "dashboard");
            }
        }
    }
}

pub fn setup(app: &AppHandle, snapshot: &Snapshot) -> tauri::Result<()> {
    let frames = Frames::load()?;
    let image = frames.image(snapshot.settings.character, snapshot.state, snapshot.frame);
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
        .on_tray_icon_event(on_tray_event)
        .build(app)?;
    #[cfg(target_os = "windows")]
    {
        let light = crate::platform::light_taskbar();
        let frame = crate::amount_icon::image("— ml", light);
        app.manage(std::sync::Mutex::new(AmountIcon {
            frame: frame.clone(),
            title: "— ml".into(),
            light,
            generation: 0,
        }));
        TrayIconBuilder::with_id("amount")
            .icon(frame)
            .tooltip("饮水陪伴 · — ml")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_tray_icon_event(on_tray_event)
            .build(app)?;
    }
    Ok(())
}

fn title(value: &Snapshot) -> String {
    let amount = value
        .drink_ml
        .map(|amount| format!("+{amount:.0}"))
        .or_else(|| {
            value
                .dashboard
                .as_ref()
                .map(|data| format!("{:.0}", data.totals.drink_ml))
        })
        .unwrap_or("—".into());
    let marker = if value.connection == Connection::Offline {
        "· "
    } else {
        ""
    };
    format!("{marker}{amount} ml")
}

pub fn render(app: &AppHandle, snapshot: &Snapshot, previous: Option<&Snapshot>) {
    let Some(tray) = app.tray_by_id("companion") else {
        return;
    };
    if previous.is_none_or(|old| {
        old.settings.character != snapshot.settings.character
            || (snapshot.settings.character == Character::Capybara
                && (old.state != snapshot.state || old.frame != snapshot.frame))
    }) {
        let frame = app.state::<Frames>().image(
            snapshot.settings.character,
            snapshot.state,
            snapshot.frame,
        );
        let _ = tray.set_icon(Some(frame));
    }
    let animate = previous.is_some_and(|old| {
        old.server == snapshot.server
            && old.session == snapshot.session
            && old.dashboard.is_some()
            && snapshot.dashboard.is_some()
    });
    #[cfg(target_os = "windows")]
    render_amount(app, &title(snapshot), animate);
    if previous.is_none_or(|old| title(old) != title(snapshot)) {
        let value = title(snapshot);
        let _ = tray.set_title(Some(&value));
        #[cfg(target_os = "macos")]
        crate::platform::animate_tray_title(&value, animate);
    }
    if previous.is_none_or(|old| {
        old.connection != snapshot.connection
            || old.last_synced_at != snapshot.last_synced_at
            || title(old) != title(snapshot)
    }) {
        let text = match snapshot.connection {
            Connection::Online => "饮水陪伴 · 已同步",
            Connection::Offline => "饮水陪伴 · 连接中断，显示上次同步数据",
            Connection::Connecting => "饮水陪伴 · 正在连接",
            Connection::SignedOut => "饮水陪伴 · 请登录",
            Connection::Unconfigured => "饮水陪伴 · 请配置服务器",
        };
        let tooltip = format!("{text} · {}", title(snapshot));
        let _ = tray.set_tooltip(Some(&tooltip));
        #[cfg(target_os = "windows")]
        if let Some(amount) = app.tray_by_id("amount") {
            let _ = amount.set_tooltip(Some(&tooltip));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_title_switches_between_total_current_drink_and_cached_total() {
        let mut snapshot = Snapshot::default();
        assert_eq!(title(&snapshot), "— ml");
        snapshot.dashboard = Some(crate::model::Dashboard {
            totals: crate::model::Totals {
                drink_ml: 1280.0,
                ..Default::default()
            },
            ..Default::default()
        });
        snapshot.connection = Connection::Online;
        assert_eq!(title(&snapshot), "1280 ml");
        snapshot.drink_ml = Some(120.0);
        assert_eq!(title(&snapshot), "+120 ml");
        snapshot.drink_ml = None;
        snapshot.connection = Connection::Offline;
        assert_eq!(title(&snapshot), "· 1280 ml");
    }

    #[test]
    fn all_menu_frames_share_dimensions_and_retain_transparency() {
        let frames = Frames::load().unwrap();
        let size = (frames.frames[0][0].width(), frames.frames[0][0].height());
        #[cfg(not(target_os = "windows"))]
        assert_eq!(size, (72, 36));
        #[cfg(target_os = "windows")]
        assert_eq!(size, (72, 72));
        for row in &frames.frames {
            for frame in row {
                assert_eq!((frame.width(), frame.height()), size);
                assert!(frame.rgba().chunks_exact(4).any(|pixel| pixel[3] == 0));
                assert!(frame.rgba().chunks_exact(4).any(|pixel| pixel[3] > 0));
            }
            assert!(row.windows(2).any(|pair| pair[0].rgba() != pair[1].rgba()));
        }
    }

    #[test]
    fn character_icons_keep_their_aspect_ratio_and_selected_artwork_in_every_state() {
        let frames = Frames::load().unwrap();
        let capybara = frames.image(Character::Capybara, CompanionState::Idle, 0);
        let mut previous = capybara.clone();
        for character in [
            Character::Robot,
            Character::Cat,
            Character::Dog,
            Character::Girl,
            Character::Boy,
        ] {
            let image = frames.image(character, CompanionState::Idle, 0);
            assert_eq!(
                (image.width(), image.height()),
                if character == Character::Robot {
                    (36, 36)
                } else {
                    (capybara.width(), capybara.height())
                }
            );
            assert!(image.rgba().chunks_exact(4).any(|pixel| pixel[3] == 0));
            assert!(
                image
                    .rgba()
                    .chunks_exact(4)
                    .filter(|pixel| pixel[3] >= 128)
                    .count()
                    > if character == Character::Robot {
                        250
                    } else {
                        500
                    }
            );
            assert_ne!(image.rgba(), previous.rgba());
            for state in [
                CompanionState::Working,
                CompanionState::Sleeping,
                CompanionState::Drinking,
                CompanionState::Reminding,
            ] {
                for frame in 0..4 {
                    assert_eq!(frames.image(character, state, frame).rgba(), image.rgba());
                }
            }
            previous = image;
        }
    }
}
