package fi.lagrange.trader.backtest

import fi.lagrange.trader.data.model.CompletedTrade
import kotlinx.datetime.LocalDate
import kotlin.math.pow
import kotlin.math.sqrt

data class BacktestReport(
    val totalTrades:     Int,
    val winningTrades:   Int,
    val losingTrades:    Int,
    val winRate:         Double,         // [0, 1]
    val avgWinR:         Double,         // avg winner in R-multiples
    val avgLossR:        Double,         // avg loser in R-multiples (positive number)
    val profitFactor:    Double,         // gross profit / gross loss
    val expectancy:      Double,         // avg P&L per trade in $
    val netReturn:       Double,         // % return on starting equity
    val annualisedReturn:Double,         // CAGR
    val sharpe:          Double,
    val sortino:         Double,
    val maxDrawdownPct:  Double,         // peak-to-trough as fraction [0, 1]
    val avgHoldMinutes:  Double,
    val tradesPerWeek:   Double,
    val equityCurve:     List<Pair<LocalDate, Double>>
) {
    fun summary(): String = buildString {
        appendLine("=== Backtest Report ===")
        appendLine("Trades:            $totalTrades  (${winningTrades}W / ${losingTrades}L)")
        appendLine("Win rate:          ${"%.1f".format(winRate * 100)}%")
        appendLine("Profit factor:     ${"%.2f".format(profitFactor)}")
        appendLine("Expectancy:        $${"%.2f".format(expectancy)}/trade")
        appendLine("Net return:        ${"%.2f".format(netReturn * 100)}%")
        appendLine("Annualised return: ${"%.2f".format(annualisedReturn * 100)}%")
        appendLine("Sharpe ratio:      ${"%.2f".format(sharpe)}")
        appendLine("Sortino ratio:     ${"%.2f".format(sortino)}")
        appendLine("Max drawdown:      ${"%.2f".format(maxDrawdownPct * 100)}%")
        appendLine("Avg hold:          ${"%.0f".format(avgHoldMinutes)} min")
        appendLine("Trades/week:       ${"%.1f".format(tradesPerWeek)}")
    }
}

object ReportGenerator {

    fun generate(result: BacktestResult): BacktestReport {
        val trades = result.trades
        if (trades.isEmpty()) return emptyReport(result.equityCurve)

        val wins   = trades.filter { it.isWinner }
        val losses = trades.filter { !it.isWinner }

        val grossProfit = wins.sumOf { it.pnl }
        val grossLoss   = losses.sumOf { it.pnl }.let { if (it != 0.0) -it else 1.0 }
        val profitFactor = grossProfit / grossLoss

        val avgWinR  = if (wins.isEmpty())   0.0 else wins.map { rMultiple(it) }.average()
        val avgLossR = if (losses.isEmpty()) 0.0 else losses.map { rMultiple(it) }.average()

        val netReturn = (result.finalEquity - result.config.startingEquity) / result.config.startingEquity

        // Annualised return from equity curve duration
        val years = result.equityCurve.let { curve ->
            if (curve.size < 2) 1.0
            else {
                val startDay = curve.first().first.toEpochDays()
                val endDay   = curve.last().first.toEpochDays()
                (endDay - startDay) / 365.25
            }
        }
        val annualisedReturn = if (years > 0)
            (1.0 + netReturn).pow(1.0 / years) - 1.0 else netReturn

        // Daily returns for Sharpe/Sortino
        val dailyReturns = dailyReturnSeries(result.equityCurve)
        val sharpe       = sharpeRatio(dailyReturns)
        val sortino      = sortinoRatio(dailyReturns)
        val maxDD        = maxDrawdown(result.equityCurve)

        val avgHold = trades.map { it.holdMinutes.toDouble() }.average()
        val weeksElapsed = (years * 52).coerceAtLeast(1.0)
        val tradesPerWeek = trades.size / weeksElapsed

        return BacktestReport(
            totalTrades      = trades.size,
            winningTrades    = wins.size,
            losingTrades     = losses.size,
            winRate          = wins.size.toDouble() / trades.size,
            avgWinR          = avgWinR,
            avgLossR         = avgLossR,
            profitFactor     = profitFactor,
            expectancy       = trades.map { it.pnl }.average(),
            netReturn        = netReturn,
            annualisedReturn = annualisedReturn,
            sharpe           = sharpe,
            sortino          = sortino,
            maxDrawdownPct   = maxDD,
            avgHoldMinutes   = avgHold,
            tradesPerWeek    = tradesPerWeek,
            equityCurve      = result.equityCurve
        )
    }

    // R-multiple: pnl / initial risk
    private fun rMultiple(trade: CompletedTrade): Double {
        val risk = trade.entry.riskAmount
        return if (risk != 0.0) trade.pnl / risk else 0.0
    }

    private fun dailyReturnSeries(curve: List<Pair<LocalDate, Double>>): List<Double> {
        if (curve.size < 2) return emptyList()
        return (1 until curve.size).map { i ->
            val prev = curve[i - 1].second
            val cur  = curve[i].second
            if (prev > 0) (cur - prev) / prev else 0.0
        }
    }

    // Annualised Sharpe assuming 252 trading days, risk-free = 0
    private fun sharpeRatio(dailyReturns: List<Double>): Double {
        if (dailyReturns.size < 2) return 0.0
        val mean = dailyReturns.average()
        val std  = std(dailyReturns)
        return if (std > 0) mean / std * sqrt(252.0) else 0.0
    }

    // Sortino uses downside deviation only
    private fun sortinoRatio(dailyReturns: List<Double>): Double {
        if (dailyReturns.size < 2) return 0.0
        val mean = dailyReturns.average()
        val negReturns = dailyReturns.filter { it < 0 }
        if (negReturns.isEmpty()) return Double.MAX_VALUE
        val downStd = sqrt(negReturns.map { it.pow(2) }.average())
        return if (downStd > 0) mean / downStd * sqrt(252.0) else 0.0
    }

    // Maximum peak-to-trough drawdown on equity curve
    private fun maxDrawdown(curve: List<Pair<LocalDate, Double>>): Double {
        if (curve.isEmpty()) return 0.0
        var peak = curve.first().second
        var maxDD = 0.0
        for ((_, equity) in curve) {
            if (equity > peak) peak = equity
            val dd = (peak - equity) / peak
            if (dd > maxDD) maxDD = dd
        }
        return maxDD
    }

    private fun std(values: List<Double>): Double {
        val mean = values.average()
        return sqrt(values.map { (it - mean).pow(2) }.average())
    }

    private fun emptyReport(curve: List<Pair<LocalDate, Double>>) = BacktestReport(
        totalTrades = 0, winningTrades = 0, losingTrades = 0,
        winRate = 0.0, avgWinR = 0.0, avgLossR = 0.0, profitFactor = 0.0,
        expectancy = 0.0, netReturn = 0.0, annualisedReturn = 0.0,
        sharpe = 0.0, sortino = 0.0, maxDrawdownPct = 0.0,
        avgHoldMinutes = 0.0, tradesPerWeek = 0.0, equityCurve = curve
    )
}
