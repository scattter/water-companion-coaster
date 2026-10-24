pub fn fit(work: [i32; 4], anchor: [i32; 4], size: [i32; 2], gap: i32) -> [i32; 4] {
    let [left, top, right, bottom] = work;
    let width = size[0].min(right - left).max(1);
    let height = size[1].min(bottom - top).max(1);
    let [x, y, ax, ay] = anchor;
    let (px, py) = if x >= right {
        (x - width - gap, ay - height)
    } else if ax <= left {
        (ax + gap, ay - height)
    } else if ay <= top {
        (ax - width, ay + gap)
    } else {
        (ax - width, y - height - gap)
    };
    [
        px.clamp(left, right - width),
        py.clamp(top, bottom - height),
        width,
        height,
    ]
}

#[cfg(test)]
mod tests {
    use super::fit;
    #[test]
    fn respects_taskbar_edges_and_negative_monitor_coordinates() {
        assert_eq!(
            fit([0, 0, 1920, 1040], [1800, 1040, 1820, 1080], [340, 460], 4),
            [1480, 576, 340, 460]
        );
        assert_eq!(
            fit([-1920, 40, 0, 1080], [-100, 0, -80, 40], [340, 460], 4),
            [-420, 44, 340, 460]
        );
        assert_eq!(
            fit([40, 0, 1920, 1080], [0, 800, 40, 820], [340, 460], 4),
            [44, 360, 340, 460]
        );
        assert_eq!(
            fit([0, 0, 300, 400], [290, 400, 310, 430], [340, 600], 4),
            [0, 0, 300, 400]
        );
    }
}
