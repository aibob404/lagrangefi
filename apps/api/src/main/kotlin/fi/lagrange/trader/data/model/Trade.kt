package fi.lagrange.trader.data.model

import kotlinx.datetime.Instant

data class TradeEntry(
    val timestamp: Instant,
    val price: Double,
    val shares: Int,
    val stopPrice: Double,
    val tp1Price: Double,
    val tp2Price: Double,
    val riskAmount: Double,
    val qualityScore: Int,
    val macroScore: Int,
    val reason: String
)

data class TradeExit(
    val timestamp: Instant,
    val price: Double,
    val shares: Int,
    val reason: ExitReason
)

enum class ExitReason {
    TP1, TP2, TP3_TRAIL, STOP_LOSS, BREAKEVEN_STOP, EOD_CLOSE, CIRCUIT_BREAKER, REGIME_CHANGE
}

data class CompletedTrade(
    val entry: TradeEntry,
    val exits: List<TradeExit>,
    val pnl: Double,
    val pnlPct: Double,
    val holdMinutes: Long
) {
    val isWinner: Boolean get() = pnl > 0
}
