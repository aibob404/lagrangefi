package fi.lagrange.trader.data.model

import kotlinx.datetime.Instant
import kotlinx.serialization.Serializable

@Serializable
data class Bar(
    val timestamp: Instant,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
    val volume: Long,
    val vwap: Double = 0.0
) {
    val typical: Double get() = (high + low + close) / 3.0
}

@Serializable
data class DailyBar(
    val date: kotlinx.datetime.LocalDate,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
    val volume: Long = 0
)

@Serializable
data class MacroSnapshot(
    val date: kotlinx.datetime.LocalDate,
    val fedFundsRate: Double,  // sourced from ^irx (13W T-bill — tracks FFR closely)
    val yield10y: Double,      // sourced from ^tnx
    val yield3m: Double,       // same as fedFundsRate (^irx)
    val hygClose: Double,
    val lqdClose: Double,
    val vixClose: Double,
    val vix3mClose: Double,
    val vvixClose: Double
)
