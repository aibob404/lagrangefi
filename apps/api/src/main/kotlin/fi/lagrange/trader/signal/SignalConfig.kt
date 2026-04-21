package fi.lagrange.trader.signal

data class SignalConfig(
    val macroGate: Int = 1,         // minimum mBase to allow trading (Gate 2)
    val rvolMin: Double = 1.5,      // minimum relative volume (Gate 7)
    val stopAtrMult: Double = 0.5   // stop distance = mult × ATR5
)
