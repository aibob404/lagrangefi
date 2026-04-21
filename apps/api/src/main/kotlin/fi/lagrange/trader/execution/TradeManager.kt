package fi.lagrange.trader.execution

import fi.lagrange.trader.data.model.Bar
import fi.lagrange.trader.data.model.ExitReason
import fi.lagrange.trader.data.model.TradeEntry
import fi.lagrange.trader.signal.Indicators
import fi.lagrange.trader.signal.TradeSignal
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.datetime.Clock
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

private data class LivePosition(
    val entry: TradeEntry,
    val leg1Shares: Int,
    val leg2Shares: Int,
    val leg3Shares: Int,
    var stopPrice: Double,
    val tp1Price: Double,
    val tp2Price: Double,
    var tp1Hit: Boolean = false,
    var tp2Hit: Boolean = false,
    var trailHigh: Double = 0.0
)

/**
 * Manages an open SPY position during live trading.
 * Mirrors [fi.lagrange.trader.backtest.Portfolio] logic but submits real orders
 * via [AlpacaOrderClient].
 *
 * Call [onSignal] when the orchestrator fires. Call [onBar] on every intraday bar.
 * Both are mutex-protected — safe to call from different coroutines.
 */
class TradeManager(
    private val orders: AlpacaOrderClient,
    private val symbol: String = "SPY"
) {
    private val mutex = Mutex()
    private var position: LivePosition? = null

    val hasOpenPosition: Boolean get() = position != null

    suspend fun onSignal(signal: TradeSignal) = mutex.withLock {
        if (position != null) return@withLock
        val entry = orders.marketBuy(symbol, signal.shares, "entry-${Clock.System.now().epochSeconds}")
        val fillPrice = entry.filledAvgPrice ?: signal.entryPrice
        val leg = signal.shares / 3
        val te = TradeEntry(
            timestamp    = Clock.System.now(),
            price        = fillPrice,
            shares       = signal.shares,
            stopPrice    = signal.stopPrice,
            tp1Price     = signal.tp1Price,
            tp2Price     = signal.tp2Price,
            riskAmount   = (fillPrice - signal.stopPrice) * signal.shares,
            qualityScore = signal.qualityScore,
            macroScore   = signal.macroScore,
            reason       = signal.reason
        )
        position = LivePosition(
            entry       = te,
            leg1Shares  = leg,
            leg2Shares  = leg,
            leg3Shares  = signal.shares - 2 * leg,
            stopPrice   = signal.stopPrice,
            tp1Price    = signal.tp1Price,
            tp2Price    = signal.tp2Price,
            trailHigh   = fillPrice
        )
    }

    suspend fun onBar(bar: Bar, atr5: Double) = mutex.withLock {
        val pos = position ?: return@withLock
        val etZone = TimeZone.of("America/New_York")
        val lt = bar.timestamp.toLocalDateTime(etZone)

        if (bar.high > pos.trailHigh) pos.trailHigh = bar.high
        val trailStop = pos.trailHigh - 2.5 * atr5

        // EOD flat at 15:55 ET
        if (lt.hour == 15 && lt.minute >= 55) {
            val rem = remainingShares(pos)
            if (rem > 0) orders.marketSell(symbol, rem, "eod-${bar.timestamp.epochSeconds}")
            position = null
            return@withLock
        }

        // Stop-loss (or breakeven stop after TP1)
        if (bar.low <= pos.stopPrice) {
            val rem = remainingShares(pos)
            val tag = if (pos.tp1Hit) ExitReason.BREAKEVEN_STOP else ExitReason.STOP_LOSS
            orders.marketSell(symbol, rem, "${tag.name.lowercase()}-${bar.timestamp.epochSeconds}")
            position = null
            return@withLock
        }

        // TP1
        if (!pos.tp1Hit && bar.high >= pos.tp1Price) {
            orders.limitSell(symbol, pos.leg1Shares, pos.tp1Price, "tp1-${bar.timestamp.epochSeconds}")
            pos.tp1Hit = true
            pos.stopPrice = pos.entry.price  // breakeven
        }

        // TP2
        if (pos.tp1Hit && !pos.tp2Hit && bar.high >= pos.tp2Price) {
            orders.limitSell(symbol, pos.leg2Shares, pos.tp2Price, "tp2-${bar.timestamp.epochSeconds}")
            pos.tp2Hit = true
        }

        // TP3 chandelier trail
        if (pos.tp1Hit && pos.tp2Hit && bar.low <= trailStop) {
            orders.marketSell(symbol, pos.leg3Shares, "tp3-${bar.timestamp.epochSeconds}")
            position = null
        }
    }

    private fun remainingShares(pos: LivePosition): Int {
        var rem = pos.leg1Shares + pos.leg2Shares + pos.leg3Shares
        if (pos.tp1Hit) rem -= pos.leg1Shares
        if (pos.tp2Hit) rem -= pos.leg2Shares
        return rem
    }
}
