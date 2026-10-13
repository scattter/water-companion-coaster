#include "weighing.h"
#include <math.h>
#include <string.h>

void weighing_init(weighing_t *machine, float empty_cup)
{
    memset(machine, 0, sizeof(*machine));
    machine->empty_cup = empty_cup;
}

static void cancel_cycle(weighing_t *machine)
{
    machine->count = 0;
    machine->next = 0;
    machine->absent = 0;
    machine->removed = false;
    machine->has_baseline = false;
}

bool weighing_sample(weighing_t *machine, float grams, int64_t time_ms, weight_change_t *change)
{
    machine->stable = false;
    machine->weight = grams;
    machine->cup_present = isfinite(grams) && grams > 5;
    if (machine->has_sample && (time_ms <= machine->last_ms || time_ms - machine->last_ms > 350))
        cancel_cycle(machine);
    machine->has_sample = true;
    machine->last_ms = time_ms;
    if (!isfinite(grams) || grams < -2 || grams > WEIGHING_MAX_GRAMS
        || machine->empty_cup < 5 || machine->empty_cup > WEIGHING_MAX_GRAMS - 5) {
        cancel_cycle(machine);
        return false;
    }
    if (grams <= 5) {
        machine->count = machine->next = 0;
        if (++machine->absent >= 5) {
            machine->removed = machine->has_baseline;
            machine->stable = true;
        }
        return false;
    }
    machine->absent = 0;
    machine->samples[machine->next] = grams;
    machine->times[machine->next] = time_ms;
    machine->next = (machine->next + 1) % WEIGHING_SAMPLES;
    if (machine->count < WEIGHING_SAMPLES) ++machine->count;
    if (machine->count < WEIGHING_SAMPLES || time_ms - machine->times[machine->next] < 1900)
        return false;
    float minimum = machine->samples[0], maximum = minimum, sum = 0;
    for (unsigned i = 0; i < WEIGHING_SAMPLES; ++i) {
        minimum = fminf(minimum, machine->samples[i]);
        maximum = fmaxf(maximum, machine->samples[i]);
        sum += machine->samples[i];
    }
    if (maximum - minimum > 1) return false;
    float after = sum / WEIGHING_SAMPLES;
    // 取放时杯子仅部分受力；低于空杯的读数稳定后才作废，保留过渡期间的基准。
    if (after < machine->empty_cup - 1) {
        cancel_cycle(machine);
        return false;
    }
    machine->stable = true;
    after = roundf(fmaxf(machine->empty_cup, after) * 10) / 10;
    float before = machine->baseline;
    bool complete = machine->removed && machine->has_baseline;
    machine->baseline = after;
    machine->has_baseline = true;
    machine->removed = false;
    if (!complete) return false;
    float delta = roundf((after - before) * 10) / 10;
    if (fabsf(delta) < 5 || (delta < 0 && -delta > before - machine->empty_cup + 0.1f))
        return false;
    *change = (weight_change_t){ .drink = delta < 0, .amount = fabsf(delta), .before = before, .after = after };
    return true;
}
