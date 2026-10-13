#pragma once
#include <stdbool.h>
#include <stdint.h>

#define WEIGHING_MAX_GRAMS 2000.0f
#define WEIGHING_SAMPLES 20

typedef struct {
    bool drink;
    float amount;
    float before;
    float after;
} weight_change_t;

typedef struct {
    float empty_cup;
    float weight;
    float baseline;
    bool has_baseline;
    bool stable;
    bool cup_present;
    bool removed;
    bool has_sample;
    unsigned absent;
    unsigned count;
    unsigned next;
    float samples[WEIGHING_SAMPLES];
    int64_t times[WEIGHING_SAMPLES];
    int64_t last_ms;
} weighing_t;

void weighing_init(weighing_t *machine, float empty_cup);
bool weighing_sample(weighing_t *machine, float grams, int64_t time_ms, weight_change_t *change);
