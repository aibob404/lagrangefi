package fi.lagrange.trader.data.model

import kotlinx.datetime.Instant

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

data class DailyBar(
    val date: kotlinx.datetime.LocalDate,
    val open: Double,
    val high: Double,
    val low: Double,
    val close: Double,
    val volume: Long = 0
)

data class FredSeries(
    val date: kotlinx.datetime.LocalDate,
    val value: Double
)

data class MacroSnapshot(
    val date: kotlinx.datetime.LocalDate,
    val fedFundsRate: Double,
    val yield2y: Double,
    val yield10y: Double,
    val yield3m: Double,
    val hygClose: Double,
    val lqdClose: Double,
    val vixClose: Double,
    val vix3mClose: Double,
    val vvixClose: Double
)
