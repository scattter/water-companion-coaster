package com.watercompanion.mobile

import org.junit.Assert.*
import org.junit.Test

class CharacterTest {
    @Test fun widgetUsesEachStoredChoiceAndDefaultsMissingOrUnknownValues() {
        for (id in listOf("robot", "capybara", "cat", "dog", "girl", "boy")) {
            assertEquals(id, Character.from(id).id)
        }
        assertEquals(Character.ROBOT, Character.from(null))
        assertEquals(Character.ROBOT, Character.from(""))
        assertEquals(Character.ROBOT, Character.from("future-character"))
        assertEquals(Character.ROBOT, Character.from("../cat.png"))
    }
}
