#include <assert.h>
#include <math.h>
#include <stdio.h>
#include "weighing.h"

typedef struct {
    weighing_t machine;
    weight_change_t changes[32];
    unsigned count;
    int64_t time;
} rig_t;

static rig_t rig(float cup)
{
    rig_t value = {0};
    weighing_init(&value.machine, cup);
    return value;
}

static void feed(rig_t *rig, float grams, unsigned samples)
{
    for (unsigned i = 0; i < samples; ++i) {
        weight_change_t change;
        if (weighing_sample(&rig->machine, grams, rig->time, &change)) {
            assert(rig->count < 32);
            rig->changes[rig->count++] = change;
        }
        rig->time += 100;
    }
}

int main(void)
{
    rig_t r = rig(120);
    feed(&r, 500, 25);
    assert(r.count == 0 && r.machine.stable && r.machine.baseline == 500);
    feed(&r, 0, 6);
    feed(&r, 450, 18);
    assert(r.count == 0 && !r.machine.stable);
    feed(&r, 450, 30);
    assert(r.count == 1 && r.changes[0].drink && r.changes[0].amount == 50);
    puts("PASS 启动不计数，稳定放回只记一次饮水");

    r = rig(272.9f);
    feed(&r, 500, 25);
    feed(&r, 380, 1); feed(&r, 180, 1); feed(&r, 30, 1);
    feed(&r, 0, 6); feed(&r, 450, 25);
    assert(r.count == 1 && r.changes[0].drink && r.changes[0].amount == 50);
    puts("PASS 拿杯经过低于空杯重量的瞬态读数不丢失饮水基准");

    r = rig(272.9f);
    feed(&r, 500, 25); feed(&r, 0, 6);
    feed(&r, 30, 1); feed(&r, 180, 1); feed(&r, 380, 1);
    feed(&r, 450, 40);
    assert(r.count == 1 && r.changes[0].drink && r.changes[0].amount == 50);
    puts("PASS 放杯经过低于空杯重量的瞬态读数只记录一次饮水");

    r = rig(120);
    feed(&r, 500, 25); feed(&r, 60, 3); feed(&r, 450, 25);
    assert(r.count == 0 && r.machine.baseline == 450);
    feed(&r, 60, 2); feed(&r, 0, 6); feed(&r, 60, 2); feed(&r, 450, 25);
    assert(r.count == 0);
    feed(&r, 60, 2); feed(&r, 0, 6); feed(&r, 60, 2); feed(&r, 550, 25);
    assert(r.count == 1 && !r.changes[0].drink && r.changes[0].amount == 100);
    puts("PASS 取放过渡不误计局部抬杯、原重放回或补水");

    r = rig(120);
    feed(&r, 500, 25);
    feed(&r, 0, 6); feed(&r, 496, 25);
    assert(r.count == 0 && r.machine.baseline == 496);
    feed(&r, 0, 6); feed(&r, 596, 25);
    assert(r.count == 1 && !r.changes[0].drink && r.changes[0].amount == 100);
    feed(&r, 0, 6); feed(&r, 591, 25);
    assert(r.count == 2 && r.changes[1].amount == 5);
    puts("PASS 补水与饮水分开，5 g 门槛");

    r = rig(120);
    feed(&r, 500, 25); feed(&r, 1200, 25); feed(&r, 500, 25);
    for (unsigned i = 1; i <= 15; ++i) feed(&r, 500 - (float)i, 25);
    assert(r.count == 0 && r.machine.baseline == 485);
    feed(&r, 0, 6); feed(&r, 435, 25);
    assert(r.count == 1 && r.changes[0].amount == 50);
    puts("PASS 静置手压和慢漂移不生成饮水");

    r = rig(120);
    feed(&r, 500, 25); feed(&r, 0, 3); feed(&r, 450, 25);
    assert(r.count == 0);
    feed(&r, 0, 6);
    for (unsigned i = 0; i < 80; ++i) feed(&r, i % 2 ? 390 : 410, 1);
    assert(!r.machine.stable && r.count == 0);
    feed(&r, 400, 25);
    assert(r.count == 1 && r.changes[0].amount == 50);
    puts("PASS 短暂掉零和抖动不能完成取放");

    r = rig(120);
    feed(&r, 500, 25); feed(&r, 0, 6); feed(&r, 100, 25);
    assert(r.count == 0 && !r.machine.has_baseline && !r.machine.stable);
    feed(&r, 450, 25);
    assert(r.count == 0 && r.machine.baseline == 450);
    feed(&r, 0, 6); feed(&r, 400, 25);
    assert(r.count == 1 && r.changes[0].amount == 50);
    puts("PASS 稳定后仍低于空杯重量才作废取放，恢复不计虚假饮水");

    const float invalid[] = {-10, 2100, NAN, INFINITY};
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        r = rig(120);
        feed(&r, 500, 25); feed(&r, 0, 6); feed(&r, invalid[i], 1); feed(&r, 450, 25);
        assert(r.count == 0 && r.machine.baseline == 450);
        feed(&r, 0, 6); feed(&r, 400, 25);
        assert(r.count == 1 && r.changes[0].amount == 50);
    }
    puts("PASS 异常读数使取放失效，恢复不计虚假饮水");

    r = rig(45);
    feed(&r, 100, 25); feed(&r, -0.6f, 6); feed(&r, 45, 25);
    assert(r.count == 1 && r.changes[0].amount == 55);
    feed(&r, 0, 6); feed(&r, 44.6f, 25);
    assert(r.count == 1);
    puts("PASS 实际空杯重量可配置，零点噪声和空杯误差不产生负水量");

    r = rig(120);
    feed(&r, 500, 25); feed(&r, 0, 6);
    r.time += 1000;
    feed(&r, 450, 25);
    assert(r.count == 0 && r.machine.baseline == 450);
    feed(&r, 0, 6);
    r.time -= 10000;
    feed(&r, 400, 25);
    assert(r.count == 0);
    weighing_init(&r.machine, 120);
    feed(&r, 350, 25);
    assert(r.count == 0 && r.machine.baseline == 350);
    puts("PASS 采样中断、时间倒退和重启均重新建立基准");

    r = rig(0);
    feed(&r, 500, 25); feed(&r, 0, 6); feed(&r, 400, 25);
    assert(r.count == 0);
    puts("PASS 未登记空杯不记录饮水");

    r = rig(120);
    feed(&r, 500, 25); feed(&r, 0, 6);
    weighing_init(&r.machine, 200);
    feed(&r, 200, 25); feed(&r, 600, 25);
    assert(r.count == 0 && r.machine.baseline == 600);
    feed(&r, 0, 6); feed(&r, 550, 25);
    assert(r.count == 1 && r.changes[0].amount == 50);
    puts("PASS 更新空杯清除旧取放基准，下一次饮水仍按差值记录");
    return 0;
}
