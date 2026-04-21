package fi.lagrange.trader.db

import fi.lagrange.model.BacktestRuns
import fi.lagrange.model.BacktestTrades
import fi.lagrange.trader.backtest.BacktestReport
import fi.lagrange.trader.data.model.CompletedTrade
import kotlinx.datetime.Clock
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.transactions.transaction

class BacktestRepository {

    fun saveRun(
        userId: Int,
        startDate: String,
        endDate: String,
        startingEquity: Double,
        riskPct: Double,
        report: BacktestReport
    ): Int = transaction {
        val equityCurveJson = report.equityCurve.joinToString(",", "[", "]") { (date, equity) ->
            """{"date":"$date","equity":$equity}"""
        }
        BacktestRuns.insert {
            it[BacktestRuns.userId]          = userId
            it[BacktestRuns.startDate]       = startDate
            it[BacktestRuns.endDate]         = endDate
            it[ranAt]                        = Clock.System.now()
            it[BacktestRuns.startingEquity]  = startingEquity
            it[BacktestRuns.riskPct]         = riskPct
            it[totalTrades]                  = report.totalTrades
            it[winningTrades]                = report.winningTrades
            it[losingTrades]                 = report.losingTrades
            it[winRate]                      = report.winRate
            it[avgWinR]                      = report.avgWinR
            it[avgLossR]                     = report.avgLossR
            it[profitFactor]                 = report.profitFactor
            it[expectancy]                   = report.expectancy
            it[netReturnPct]                 = report.netReturn
            it[annualisedReturnPct]          = report.annualisedReturn
            it[sharpe]                       = report.sharpe
            it[sortino]                      = report.sortino
            it[maxDrawdownPct]               = report.maxDrawdownPct
            it[avgHoldMinutes]               = report.avgHoldMinutes
            it[tradesPerWeek]                = report.tradesPerWeek
            it[BacktestRuns.equityCurveJson] = equityCurveJson
        }[BacktestRuns.id]
    }

    fun saveTrades(backtestRunId: Int, userId: Int, trades: List<CompletedTrade>) = transaction {
        for (trade in trades) {
            val lastExit  = trade.exits.lastOrNull()
            val rMultiple = if (trade.entry.riskAmount != 0.0) trade.pnl / trade.entry.riskAmount else 0.0
            BacktestTrades.insert {
                it[BacktestTrades.backtestRunId] = backtestRunId
                it[BacktestTrades.userId]        = userId
                it[entryAt]                      = trade.entry.timestamp
                it[exitAt]                       = lastExit?.timestamp
                it[entryPrice]                   = trade.entry.price
                it[exitPrice]                    = lastExit?.price
                it[shares]                       = trade.entry.shares
                it[pnl]                          = trade.pnl
                it[pnlPct]                       = trade.pnlPct
                it[holdMinutes]                  = trade.holdMinutes
                it[BacktestTrades.rMultiple]     = rMultiple
                it[riskAmount]                   = trade.entry.riskAmount
                it[stopPrice]                    = trade.entry.stopPrice
                it[qualityScore]                 = trade.entry.qualityScore
                it[macroScore]                   = trade.entry.macroScore
                it[exitReason]                   = lastExit?.reason?.name
                it[entryReason]                  = trade.entry.reason
            }
        }
    }

    fun listRuns(userId: Int): List<ResultRow> = transaction {
        BacktestRuns.selectAll()
            .where { BacktestRuns.userId eq userId }
            .orderBy(BacktestRuns.ranAt, SortOrder.DESC)
            .toList()
    }

    fun getTrades(backtestRunId: Int, userId: Int): List<ResultRow> = transaction {
        BacktestTrades.selectAll()
            .where {
                (BacktestTrades.backtestRunId eq backtestRunId) and
                (BacktestTrades.userId eq userId)
            }
            .orderBy(BacktestTrades.entryAt, SortOrder.ASC)
            .toList()
    }
}
