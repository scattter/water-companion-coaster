#pragma once
#include <stdbool.h>
#include <stdint.h>

enum { BUTTON_WAKE = 1, BUTTON_DOUBLE = 2, BUTTON_LONG = 4 };
typedef struct {
    bool raw_down, down, long_handled, waiting;
    uint32_t changed_at, pressed_at, released_at;
} button_t;

static inline unsigned button_poll(button_t *button, bool down, uint32_t now)
{
    unsigned events = 0;
    if (down != button->raw_down) { button->raw_down = down; button->changed_at = now; }
    if (button->raw_down != button->down && now - button->changed_at >= 30) {
        button->down = button->raw_down;
        if (button->down) {
            button->pressed_at = now;
            button->long_handled = false;
            events |= BUTTON_WAKE;
        } else if (!button->long_handled && now - button->pressed_at <= 400) {
            if (button->waiting && button->pressed_at - button->released_at <= 400) {
                events |= BUTTON_DOUBLE;
                button->waiting = false;
            } else { button->waiting = true; button->released_at = now; }
        } else button->waiting = false;
    }
    if (button->down && !button->long_handled && now - button->pressed_at >= 3000) {
        button->long_handled = true;
        button->waiting = false;
        events |= BUTTON_LONG;
    }
    if (!button->down && !button->raw_down && button->waiting && now - button->released_at > 400)
        button->waiting = false;
    return events;
}
