package fi.lagrange.trader.backtest

import fi.lagrange.trader.data.model.Bar
import fi.lagrange.trader.data.model.CompletedTrade
import fi.lagrange.trader.data.model.DailyBar
import fi.lagrange.trader.data.model.MacroSnapshot
import fi.lagrange.trader.signal.Indicators
import fi.lagrange.trader.signal.MacroRegimeEngine
import fi.lagrange.trader.signal.OrchestratorInput
import fi.lagrange.trader.signal.SignalOrchestrator
import fi.lagrange.trader.signal.TradeDirection
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

data class BacktestConfig(
    val startDate: LocalDate,
    val endDate: LocalDate,
    val startingEquity: Double = 100_000.0,
    val riskPct: Double = 0.005,         // 0.5% base risk per trade
    val kStop: Double = 1.5              // ATR multiple for initial stop
)

data class BacktestResult(
    val trades: List<CompletedTrade>,
    val equityCurve: List<Pair<LocalDate, Double>>,
    val finalEquity: Double,
    val config: BacktestConfig
)

/**
 * Replays historical 5-minute bars through the same [SignalOrchestrator] used in live.
 * Signal logic is identical — only the data feed differs.
 *
 * Input data requirements:
 *  - [dailyBars]     — full SPY daily history (200+ bars before [startDate])
 *  - [intradayBars]  — all SPY 5-min bars across the backtest range
 *  - [macroHistory]  — daily MacroSnapshots (FRED + VIX data)
 */
class BacktestEngine(
    private val orchestrator: SignalOrchestrator = SignalOrchestrator(),
    private val macroEngine: MacroRegimeEngine = MacroRegimeEngine()
) {

    fun run(
        dailyBars: List<DailyBar>,
        intradayBars: List<Bar>,
        macroHistory: List<MacroSnapshot>,
        config: BacktestConfig,
        onProgress: (String) -> Unit = {}
    ): BacktestResult {
        val portfolio    = Portfolio(config.startingEquity)
        val equityCurve  = mutableListOf<Pair<LocalDate, Double>>()
        val etZone       = TimeZone.of("America/New_York")

        // Group intraday bars by trading date (ET)
        val barsByDate: Map<LocalDate, List<Bar>> = intradayBars
            .filter { bar ->
                val d = bar.timestamp.toLocalDateTime(etZone).date
                d >= config.startDate && d <= config.endDate
            }
            .groupBy { bar -> bar.timestamp.toLocalDateTime(etZone).date }
            .mapValues { (_, bars) -> bars.sortedBy { it.timestamp } }

        val tradingDates = barsByDate.keys.sorted()
        val totalDays    = tradingDates.size
        val reportEvery  = maxOf(1, totalDays / 20)  // ~5% increments

        var lastWeekOfYear = -1
        var lastMonth      = -1

        for ((dayIdx, date) in tradingDates.withIndex()) {
            if (dayIdx % reportEvery == 0) {
                val pct = if (totalDays > 0) dayIdx * 100 / totalDays else 0
                onProgress("Engine: $dayIdx/$totalDays days ($pct%) — ${portfolio.completedTrades.size} trades so far")
            }
            val dayBars = barsByDate[date] ?: continue

            // Reset daily circuit-breaker window
            portfolio.resetDailyPnl()

            // Weekly / monthly resets
            val weekOfYear = date.dayOfYear / 7
            if (weekOfYear != lastWeekOfYear) { portfolio.resetWeeklyPnl(); lastWeekOfYear = weekOfYear }
            val month = date.monthNumber
            if (month != lastMonth) { portfolio.resetMonthlyPnl(); lastMonth = month }

            // Slice daily bars available up to (and including) prior day
            val dailyWindow = dailyBars.filter { it.date < date }
            val macroWindow = macroHistory.filter { it.date <= date }
            if (dailyWindow.size < 200 || macroWindow.isEmpty()) continue

            // Precompute macro regime once per day — avoids O(n²) SMA/ADX per intraday bar
            val macroRegimeResult = macroEngine.compute(dailyWindow, macroWindow) ?: continue

            // Precompute daily ATR (used for both ORB range check and stop sizing)
            val dHighs  = dailyWindow.map { it.high }.toDoubleArray()
            val dLows   = dailyWindow.map { it.low }.toDoubleArray()
            val dCloses = dailyWindow.map { it.close }.toDoubleArray()
            val dailyAtrArr = Indicators.atr(dHighs, dLows, dCloses, 14)
            val dailyAtr = dailyAtrArr.lastOrNull { !it.isNaN() } ?: continue

            // 5-min ATR (last 14 bars of prior day — approximation)
            val prior5mBars = intradayBars
                .filter { bar -> bar.timestamp.toLocalDateTime(etZone).date < date }
                .takeLast(100)
            val atr5 = if (prior5mBars.size >= 14) {
                val h = prior5mBars.map { it.high }.toDoubleArray()
                val l = prior5mBars.map { it.low }.toDoubleArray()
                val c = prior5mBars.map { it.close }.toDoubleArray()
                Indicators.atr(h, l, c, 14).lastOrNull { !it.isNaN() } ?: dailyAtr / 5.0
            } else dailyAtr / 5.0

            // Process each 5-min bar intraday
            val sessionBarsAccum = mutableListOf<Bar>()

            for (bar in dayBars) {
                sessionBarsAccum.add(bar)
                val lt = bar.timestamp.toLocalDateTime(etZone)
                val timeEt = LocalTime(lt.hour, lt.minute)

                // 1. Manage existing position first
                if (portfolio.hasOpenPosition) {
                    portfolio.onBar(bar, atr5)
                    continue  // no new entries while in a trade (Phase 1: 1 position)
                }

                // 2. Skip if any circuit breaker is tripped
                if (portfolio.isDayHalted || portfolio.isWeekHalted ||
                    portfolio.isMonthHalted || portfolio.isPeakHalted) continue

                // 3. Evaluate entry signal
                val input = OrchestratorInput(
                    spyDailyBars    = dailyWindow,
                    spy5minBars     = sessionBarsAccum,
                    macroHistory    = macroWindow,
                    date            = date,
                    timeEt          = timeEt,
                    accountEquity   = portfolio.equity,
                    riskPct         = config.riskPct,
                    dailyPnl        = portfolio.dailyPnl,
                    weeklyPnl       = portfolio.weeklyPnl,
                    hasOpenPosition = portfolio.hasOpenPosition,
                    precomputedMacro = macroRegimeResult
                )
                val signal = orchestrator.evaluate(input)
                if (signal.direction == TradeDirection.LONG) {
                    portfolio.onSignal(signal, bar.timestamp)
                }
            }

            // Force-close any open position at EOD (belt-and-suspenders on top of 15:55 check in Portfolio)
            if (portfolio.hasOpenPosition) {
                val lastBar = dayBars.last()
                portfolio.onBar(lastBar.copy(
                    timestamp = lastBar.timestamp,
                    open = lastBar.close, high = lastBar.close,
                    low = lastBar.close, close = lastBar.close
                ), atr5)
            }

            equityCurve.add(date to portfolio.equity)
        }

        return BacktestResult(
            trades      = portfolio.completedTrades.toList(),
            equityCurve = equityCurve,
            finalEquity = portfolio.equity,
            config      = config
        )
    }
}
