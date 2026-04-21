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
    val isShort: Boolean,
    val leg1: Int,
    val leg2: Int,
    val leg3: Int,
    var stopPrice: Double,
    val tp1Price: Double,
    val tp2Price: Double,
    var tp1Hit: Boolean = false,
    var tp2Hit: Boolean = false,
    var trailExtreme: Double = 0.0   // for longs: highest high; for shorts: lowest low
)

class Portfolio(startingEquity: Double) {

    var equity: Double = startingEquity
        private set

    private var position: OpenPosition? = null

    val completedTrades: MutableList<CompletedTrade> = mutableListOf()

    var dailyPnl:   Double = 0.0; private set
    var weeklyPnl:  Double = 0.0; private set
    var monthlyPnl: Double = 0.0; private set
    var peakEquity: Double = startingEquity; private set

    val hasOpenPosition: Boolean get() = position != null
    val isDayHalted:     Boolean get() = dailyPnl   < -equity * 0.020
    val isWeekHalted:    Boolean get() = weeklyPnl  < -equity * 0.040
    val isMonthHalted:   Boolean get() = monthlyPnl < -equity * 0.070
    val isPeakHalted:    Boolean get() = equity     < peakEquity * 0.850

    private val slippagePct = 0.0001

    fun resetDailyPnl()   { dailyPnl  = 0.0 }
    fun resetWeeklyPnl()  { weeklyPnl = 0.0 }
    fun resetMonthlyPnl() { monthlyPnl = 0.0 }

    fun onSignal(signal: TradeSignal, now: Instant) {
        if (position != null) return
        val isShort = signal.direction == TradeDirection.SHORT
        if (!isShort && signal.direction != TradeDirection.LONG) return

        // slippage: longs fill slightly above, shorts slightly below
        val entryPrice = if (isShort) signal.entryPrice * (1.0 - slippagePct)
                         else         signal.entryPrice * (1.0 + slippagePct)
        val shares = signal.shares
        val leg    = shares / 3
        val entry  = TradeEntry(
            timestamp    = now,
            price        = entryPrice,
            shares       = shares,
            stopPrice    = signal.stopPrice,
            tp1Price     = signal.tp1Price,
            tp2Price     = signal.tp2Price,
            riskAmount   = if (isShort) (signal.stopPrice - entryPrice) * shares
                           else         (entryPrice - signal.stopPrice) * shares,
            qualityScore = signal.qualityScore,
            macroScore   = signal.macroScore,
            reason       = signal.reason
        )
        position = OpenPosition(
            entry         = entry,
            isShort       = isShort,
            leg1          = leg,
            leg2          = leg,
            leg3          = shares - 2 * leg,
            stopPrice     = signal.stopPrice,
            tp1Price      = signal.tp1Price,
            tp2Price      = signal.tp2Price,
            trailExtreme  = entryPrice
        )
    }

    fun onBar(bar: Bar, atr5: Double): CompletedTrade? {
        val pos = position ?: return null
        val exits = mutableListOf<TradeExit>()
        val etZone = TimeZone.of("America/New_York")
        val lt = bar.timestamp.toLocalDateTime(etZone)

        // Update chandelier extreme
        if (pos.isShort) {
            if (bar.low < pos.trailExtreme) pos.trailExtreme = bar.low
        } else {
            if (bar.high > pos.trailExtreme) pos.trailExtreme = bar.high
        }
        val trailStop = if (pos.isShort) pos.trailExtreme + 2.5 * atr5
                        else             pos.trailExtreme - 2.5 * atr5

        // --- EOD time-stop at 15:55 ET ---
        val isEod = lt.hour == 15 && lt.minute >= 55
        if (isEod) {
            val exitPrice = if (pos.isShort) bar.close * (1.0 + slippagePct)
                            else             bar.close * (1.0 - slippagePct)
            val remainingShares = remainingShares(pos)
            if (remainingShares > 0) exits.add(TradeExit(bar.timestamp, exitPrice, remainingShares, ExitReason.EOD_CLOSE))
            return close(pos, exits)
        }

        val stopHit = if (pos.isShort) bar.high >= pos.stopPrice else bar.low <= pos.stopPrice
        if (stopHit) {
            val exitPrice = if (pos.isShort) (pos.stopPrice * (1.0 + slippagePct)).coerceAtLeast(bar.open)
                            else             (pos.stopPrice * (1.0 - slippagePct)).coerceAtMost(bar.open)
            val remainingShares = remainingShares(pos)
            val reason = if (pos.tp1Hit) ExitReason.BREAKEVEN_STOP else ExitReason.STOP_LOSS
            exits.add(TradeExit(bar.timestamp, exitPrice, remainingShares, reason))
            return close(pos, exits)
        }

        // TP1
        val tp1Hit = if (pos.isShort) bar.low <= pos.tp1Price else bar.high >= pos.tp1Price
        if (!pos.tp1Hit && tp1Hit) {
            val exitPrice = if (pos.isShort) pos.tp1Price * (1.0 + slippagePct)
                            else             pos.tp1Price * (1.0 - slippagePct)
            exits.add(TradeExit(bar.timestamp, exitPrice, pos.leg1, ExitReason.TP1))
            pos.tp1Hit = true
            pos.stopPrice = pos.entry.price  // move to breakeven
        }

        // TP2
        val tp2Hit = if (pos.isShort) bar.low <= pos.tp2Price else bar.high >= pos.tp2Price
        if (pos.tp1Hit && !pos.tp2Hit && tp2Hit) {
            val exitPrice = if (pos.isShort) pos.tp2Price * (1.0 + slippagePct)
                            else             pos.tp2Price * (1.0 - slippagePct)
            exits.add(TradeExit(bar.timestamp, exitPrice, pos.leg2, ExitReason.TP2))
            pos.tp2Hit = true
        }

        // TP3: chandelier trail
        val trailHit = if (pos.isShort) bar.high >= trailStop else bar.low <= trailStop
        if (pos.tp1Hit && pos.tp2Hit && trailHit) {
            val exitPrice = if (pos.isShort) (trailStop * (1.0 + slippagePct)).coerceAtLeast(bar.open)
                            else             (trailStop * (1.0 - slippagePct)).coerceAtMost(bar.open)
            exits.add(TradeExit(bar.timestamp, exitPrice, pos.leg3, ExitReason.TP3_TRAIL))
            return close(pos, exits)
        }

        if (exits.isNotEmpty()) exits.forEach { exit -> applyPnl(pos, exit) }
        return null
    }

    private fun remainingShares(pos: OpenPosition): Int {
        var rem = pos.leg1 + pos.leg2 + pos.leg3
        if (pos.tp1Hit) rem -= pos.leg1
        if (pos.tp2Hit) rem -= pos.leg2
        return rem
    }

    private fun close(pos: OpenPosition, exits: List<TradeExit>): CompletedTrade {
        exits.forEach { exit -> applyPnl(pos, exit) }
        val sign        = if (pos.isShort) -1.0 else 1.0
        val totalPnl    = exits.sumOf { (it.price - pos.entry.price) * it.shares * sign }
        val totalShares = pos.leg1 + pos.leg2 + pos.leg3
        val pnlPct      = totalPnl / (pos.entry.price * totalShares)
        val holdMs      = (exits.last().timestamp - pos.entry.timestamp).inWholeMilliseconds
        val trade       = CompletedTrade(pos.entry, exits, totalPnl, pnlPct, holdMs / 60_000)
        completedTrades.add(trade)
        position = null
        return trade
    }

    private fun applyPnl(pos: OpenPosition, exit: TradeExit) {
        val sign = if (pos.isShort) -1.0 else 1.0
        val pnl  = (exit.price - pos.entry.price) * exit.shares * sign
        equity      += pnl
        dailyPnl    += pnl
        weeklyPnl   += pnl
        monthlyPnl  += pnl
        if (equity > peakEquity) peakEquity = equity
    }
}
