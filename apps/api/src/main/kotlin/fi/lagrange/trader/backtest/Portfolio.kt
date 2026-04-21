package fi.lagrange.trader.backtest

import fi.lagrange.trader.data.model.Bar
import fi.lagrange.trader.data.model.CompletedTrade
import fi.lagrange.trader.data.model.ExitReason
import fi.lagrange.trader.data.model.TradeEntry
import fi.lagrange.trader.data.model.TradeExit
import fi.lagrange.trader.signal.TradeDirection
import fi.lagrange.trader.signal.TradeSignal
import kotlinx.datetime.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

private data class OpenPosition(
    val entry: TradeEntry,
    val leg1: Int,             // shares in each leg
    val leg2: Int,
    val leg3: Int,
    var stopPrice: Double,
    val tp1Price: Double,
    val tp2Price: Double,
    var tp1Hit: Boolean = false,
    var tp2Hit: Boolean = false,
    var trailHigh: Double = 0.0
)

/**
 * Tracks equity, open position, and completed trades for one backtest run.
 *
 * Call [onSignal] when the orchestrator produces a LONG entry.
 * Call [onBar] for every 5-minute bar to check TP/stop/EOD exit.
 * Circuit-breaker state is checked externally via [isDayHalted], [isWeekHalted].
 */
class Portfolio(startingEquity: Double) {

    var equity: Double = startingEquity
        private set

    private var position: OpenPosition? = null

    val completedTrades: MutableList<CompletedTrade> = mutableListOf()

    // Running P&L windows for circuit breakers
    var dailyPnl:   Double = 0.0; private set
    var weeklyPnl:  Double = 0.0; private set
    var monthlyPnl: Double = 0.0; private set
    var peakEquity: Double = startingEquity; private set

    val hasOpenPosition: Boolean get() = position != null
    val isDayHalted:     Boolean get() = dailyPnl   < -equity * 0.020
    val isWeekHalted:    Boolean get() = weeklyPnl  < -equity * 0.040
    val isMonthHalted:   Boolean get() = monthlyPnl < -equity * 0.070
    val isPeakHalted:    Boolean get() = equity     < peakEquity * 0.850

    // Slippage model: 1bp per side during regular hours
    private val slippagePct = 0.0001

    fun resetDailyPnl()   { dailyPnl  = 0.0 }
    fun resetWeeklyPnl()  { weeklyPnl = 0.0 }
    fun resetMonthlyPnl() { monthlyPnl = 0.0 }

    fun onSignal(signal: TradeSignal, now: Instant) {
        if (signal.direction != TradeDirection.LONG || position != null) return
        val entryWithSlippage = signal.entryPrice * (1.0 + slippagePct)
        val shares = signal.shares
        val leg    = shares / 3
        val entry  = TradeEntry(
            timestamp    = now,
            price        = entryWithSlippage,
            shares       = shares,
            stopPrice    = signal.stopPrice,
            tp1Price     = signal.tp1Price,
            tp2Price     = signal.tp2Price,
            riskAmount   = (entryWithSlippage - signal.stopPrice) * shares,
            qualityScore = signal.qualityScore,
            macroScore   = signal.macroScore,
            reason       = signal.reason
        )
        position = OpenPosition(
            entry     = entry,
            leg1      = leg,
            leg2      = leg,
            leg3      = shares - 2 * leg,
            stopPrice = signal.stopPrice,
            tp1Price  = signal.tp1Price,
            tp2Price  = signal.tp2Price,
            trailHigh = entryWithSlippage
        )
    }

    /**
     * Called on every 5-minute bar. Checks stop-loss, TP1, TP2, TP3 trail, and EOD time-stop.
     * Returns a [CompletedTrade] if the position was fully closed this bar, else null.
     */
    fun onBar(bar: Bar, atr5: Double): CompletedTrade? {
        val pos = position ?: return null
        val exits = mutableListOf<TradeExit>()
        val etZone = TimeZone.of("America/New_York")
        val lt = bar.timestamp.toLocalDateTime(etZone)

        // Update chandelier trail high
        if (bar.high > pos.trailHigh) pos.trailHigh = bar.high
        val trailStop = pos.trailHigh - 2.5 * atr5

        // --- EOD time-stop at 15:55 ET ---
        val isEod = lt.hour == 15 && lt.minute >= 55
        if (isEod) {
            val exitPrice = bar.close * (1.0 - slippagePct)
            val remainingShares = remainingShares(pos)
            if (remainingShares > 0) exits.add(TradeExit(bar.timestamp, exitPrice, remainingShares, ExitReason.EOD_CLOSE))
            return close(pos, exits)
        }

        // --- Stop-loss (or breakeven stop after TP1) ---
        if (bar.low <= pos.stopPrice) {
            val exitPrice = (pos.stopPrice * (1.0 - slippagePct)).coerceAtMost(bar.open)
            val remainingShares = remainingShares(pos)
            val reason = if (pos.tp1Hit) ExitReason.BREAKEVEN_STOP else ExitReason.STOP_LOSS
            exits.add(TradeExit(bar.timestamp, exitPrice, remainingShares, reason))
            return close(pos, exits)
        }

        // --- TP1 (1R) ---
        if (!pos.tp1Hit && bar.high >= pos.tp1Price) {
            val exitPrice = pos.tp1Price * (1.0 - slippagePct)
            exits.add(TradeExit(bar.timestamp, exitPrice, pos.leg1, ExitReason.TP1))
            pos.tp1Hit = true
            pos.stopPrice = pos.entry.price  // move to breakeven
        }

        // --- TP2 (2R) ---
        if (pos.tp1Hit && !pos.tp2Hit && bar.high >= pos.tp2Price) {
            val exitPrice = pos.tp2Price * (1.0 - slippagePct)
            exits.add(TradeExit(bar.timestamp, exitPrice, pos.leg2, ExitReason.TP2))
            pos.tp2Hit = true
        }

        // --- TP3: chandelier trailing stop (only when TP1 and TP2 already hit) ---
        if (pos.tp1Hit && pos.tp2Hit && bar.low <= trailStop) {
            val exitPrice = (trailStop * (1.0 - slippagePct)).coerceAtMost(bar.open)
            exits.add(TradeExit(bar.timestamp, exitPrice, pos.leg3, ExitReason.TP3_TRAIL))
            return close(pos, exits)
        }

        // Record partial exits (TP1/TP2) — position still open
        if (exits.isNotEmpty()) {
            exits.forEach { exit -> applyPnl(pos.entry, exit) }
        }
        return null
    }

    private fun remainingShares(pos: OpenPosition): Int {
        var rem = pos.leg1 + pos.leg2 + pos.leg3
        if (pos.tp1Hit) rem -= pos.leg1
        if (pos.tp2Hit) rem -= pos.leg2
        return rem
    }

    private fun close(pos: OpenPosition, exits: List<TradeExit>): CompletedTrade {
        exits.forEach { exit -> applyPnl(pos.entry, exit) }
        val totalPnl    = exits.sumOf { (it.price - pos.entry.price) * it.shares }
        val totalShares = pos.leg1 + pos.leg2 + pos.leg3
        val pnlPct      = totalPnl / (pos.entry.price * totalShares)
        val holdMs      = (exits.last().timestamp - pos.entry.timestamp).inWholeMilliseconds
        val trade       = CompletedTrade(pos.entry, exits, totalPnl, pnlPct, holdMs / 60_000)
        completedTrades.add(trade)
        position = null
        return trade
    }

    private fun applyPnl(entry: TradeEntry, exit: TradeExit) {
        val pnl = (exit.price - entry.price) * exit.shares
        equity      += pnl
        dailyPnl    += pnl
        weeklyPnl   += pnl
        monthlyPnl  += pnl
        if (equity > peakEquity) peakEquity = equity
    }
}
