package com.watercompanion.mobile

internal enum class Character(val id: String, val label: String) {
    ROBOT("robot", "小机器人"),
    CAPYBARA("capybara", "水豚"),
    CAT("cat", "灰白小猫"),
    DOG("dog", "奶油小狗"),
    GIRL("girl", "女生"),
    BOY("boy", "男生");

    companion object {
        fun from(value: String?): Character = values().firstOrNull { it.id == value } ?: ROBOT
    }
}
