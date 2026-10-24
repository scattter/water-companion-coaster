package com.watercompanion.mobile

internal data class Binding(val user: String, val device: String?, val batch: String?)

// Access is serialized by Repository's lock. An auth/binding change invalidates all older replies.
internal class SessionEpoch(initial: Long, initialBinding: Binding?) {
    var value = initial
        private set
    var binding = initialBinding
        private set
    fun accepts(request: Long) = value == request
    fun advance() { value++ }
    fun observe(next: Binding?): Boolean {
        if (binding == next) return false
        binding = next
        advance()
        return true
    }
}

internal object WidgetSchedule {
    const val MINUTES = 15L
    fun enabled(count: Int, signedIn: Boolean) = count > 0 && signedIn
}
