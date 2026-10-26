use tauri::image::Image;

pub const SIZE: u32 = 64;

fn glyph(value: char) -> [u8; 7] {
    match value {
        '0' => [7, 5, 5, 5, 5, 5, 7],
        '1' => [2, 6, 2, 2, 2, 2, 7],
        '2' => [7, 1, 1, 7, 4, 4, 7],
        '3' => [7, 1, 1, 7, 1, 1, 7],
        '4' => [5, 5, 5, 7, 1, 1, 1],
        '5' => [7, 4, 4, 7, 1, 1, 7],
        '6' => [7, 4, 4, 7, 5, 5, 7],
        '7' => [7, 1, 1, 2, 2, 2, 2],
        '8' => [7, 5, 5, 7, 5, 5, 7],
        '9' => [7, 5, 5, 7, 1, 1, 7],
        '+' => [0, 2, 2, 7, 2, 2, 0],
        '-' | '—' => [0, 0, 0, 7, 0, 0, 0],
        '·' => [0, 0, 0, 2, 0, 0, 0],
        'm' => [0, 0, 7, 7, 5, 5, 5],
        'l' => [4, 4, 4, 4, 4, 4, 7],
        _ => [0; 7],
    }
}

fn line(pixels: &mut [u8], value: &str, y: u32, scale_y: u32, color: u8) {
    let columns = (value.chars().count() as u32 * 4).saturating_sub(1).max(1);
    let scale_x = ((SIZE - 4) / columns).clamp(1, 4);
    let left = SIZE.saturating_sub(columns * scale_x) / 2;
    for (index, character) in value.chars().enumerate() {
        for (row, bits) in glyph(character).iter().enumerate() {
            for column in 0..3 {
                if bits & (1 << (2 - column)) == 0 {
                    continue;
                }
                for dy in 0..scale_y {
                    for dx in 0..scale_x {
                        let x = left + (index as u32 * 4 + column) * scale_x + dx;
                        let y = y + row as u32 * scale_y + dy;
                        if x < SIZE && y < SIZE {
                            let offset = ((y * SIZE + x) * 4) as usize;
                            pixels[offset..offset + 4].copy_from_slice(&[color, color, color, 255]);
                        }
                    }
                }
            }
        }
    }
}

pub fn image(title: &str, light: bool) -> Image<'static> {
    let mut pixels = vec![0; (SIZE * SIZE * 4) as usize];
    let value = title.trim_start_matches("· ").trim_end_matches(" ml");
    let color = if light { 32 } else { 245 };
    line(&mut pixels, value, 4, 5, color);
    line(
        &mut pixels,
        if title.starts_with('·') {
            "· ml"
        } else {
            "ml"
        },
        44,
        2,
        color,
    );
    Image::new_owned(pixels, SIZE, SIZE)
}

pub fn ease(progress: f64) -> f64 {
    if progress <= 0.0 || progress >= 1.0 {
        return progress.clamp(0.0, 1.0);
    }
    let (mut low, mut high) = (0.0, 1.0);
    for _ in 0..24 {
        let t = (low + high) / 2.0;
        let x = 3.0 * (1.0 - t) * (1.0 - t) * t * 0.22 + 3.0 * (1.0 - t) * t * t * 0.24 + t * t * t;
        if x < progress {
            low = t;
        } else {
            high = t;
        }
    }
    let t = (low + high) / 2.0;
    3.0 * (1.0 - t) * (1.0 - t) * t * 0.75 + 3.0 * (1.0 - t) * t * t + t * t * t
}

pub fn slide(before: &Image<'_>, after: &Image<'_>, progress: f64) -> Image<'static> {
    let progress = progress.clamp(0.0, 1.0);
    let offset = (progress * SIZE as f64).round() as u32;
    let mut pixels = vec![0; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        let (source, row, opacity) = if y + offset < SIZE {
            (before.rgba(), y + offset, 1.0 - progress)
        } else {
            (after.rgba(), y + offset - SIZE, progress)
        };
        for x in 0..SIZE {
            let from = ((row * SIZE + x) * 4) as usize;
            let to = ((y * SIZE + x) * 4) as usize;
            pixels[to..to + 3].copy_from_slice(&source[from..from + 3]);
            pixels[to + 3] = (source[from + 3] as f64 * opacity).round() as u8;
        }
    }
    Image::new_owned(pixels, SIZE, SIZE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transitions_keep_the_endpoints_and_move_both_rows_up() {
        let before = image("1280 ml", true);
        let after = image("+120 ml", true);
        assert_eq!(slide(&before, &after, 0.0).rgba(), before.rgba());
        assert_eq!(slide(&before, &after, 1.0).rgba(), after.rgba());
        let middle = slide(&before, &after, 0.5);
        for y in 0..SIZE {
            for x in 0..SIZE {
                let target = ((y * SIZE + x) * 4) as usize;
                let source = if y < SIZE / 2 {
                    before.rgba()
                } else {
                    after.rgba()
                };
                let origin = ((((y + SIZE / 2) % SIZE) * SIZE + x) * 4) as usize;
                assert_eq!(
                    &middle.rgba()[target..target + 3],
                    &source[origin..origin + 3]
                );
                assert_eq!(
                    middle.rgba()[target + 3],
                    (source[origin + 3] as f64 * 0.5).round() as u8
                );
            }
        }
    }

    #[test]
    fn icons_keep_transparency_and_follow_taskbar_appearance() {
        for title in ["— ml", "0 ml", "1280 ml", "+0 ml", "+120 ml", "· 99999 ml"] {
            for light in [false, true] {
                let icon = image(title, light);
                assert_eq!((icon.width(), icon.height()), (SIZE, SIZE));
                assert!(icon.rgba().chunks_exact(4).any(|p| p[3] == 0));
                assert!(icon
                    .rgba()
                    .chunks_exact(4)
                    .any(|p| p[3] == 255 && p[0] == if light { 32 } else { 245 }));
            }
        }
        assert_eq!(ease(0.0), 0.0);
        assert_eq!(ease(1.0), 1.0);
        assert!((1..=100).all(|step| ease(step as f64 / 100.0) >= ease((step - 1) as f64 / 100.0)));
    }
}
