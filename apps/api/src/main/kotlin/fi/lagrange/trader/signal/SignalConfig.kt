package fi.lagrange.trader.signal

data class SignalConfig(
    val macroGate: Int = 1,
    val rvolMin: Double = 1.5,
    val stopAtrMult: Double = 0.5,
    val retestEntry: Boolean = false,
    val rsiMin: Double = 50.0,
    val rsiMax: Double = 70.0,
    val requireMacd: Boolean = true,
    val allowShorts: Boolean = false,   // enable bearish ORB breakdown trades
    val shortMacroGate: Int = -1        // shorts require mBase ≤ shortMacroGate
)
