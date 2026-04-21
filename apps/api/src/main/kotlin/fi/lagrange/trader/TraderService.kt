package fi.lagrange.trader

import fi.lagrange.trader.backtest.BacktestConfig
import fi.lagrange.trader.backtest.BacktestEngine
import fi.lagrange.trader.backtest.BacktestResult
import fi.lagrange.trader.backtest.ReportGenerator
import fi.lagrange.trader.data.AlpacaHistoricalClient
import fi.lagrange.trader.data.AlpacaStreamClient
import fi.lagrange.trader.data.MacroDataService
import fi.lagrange.trader.data.YahooFinanceClient
import fi.lagrange.trader.data.model.Bar
import fi.lagrange.trader.data.model.MacroSnapshot
import fi.lagrange.trader.execution.AlpacaOrderClient
import fi.lagrange.trader.execution.TradeManager
import fi.lagrange.trader.signal.Indicators
import fi.lagrange.trader.signal.MacroRegimeResult
import fi.lagrange.trader.signal.OrchestratorInput
import fi.lagrange.trader.signal.SignalOrchestrator
import fi.lagrange.trader.signal.VolatilityRegimeEngine
import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.client.plugins.websocket.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.datetime.Clock
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory

@kotlinx.serialization.Serializable
data class TraderStatus(
    val running: Boolean,
    val accountEquity: Double,
    val dailyPnl: Double,
    val hasOpenPosition: Boolean,
    val macroRegime: String,
    val vixRegime: String,
    val lastSignalReason: String
)

/**
 * Facade that initialises all data clients, the signal orchestrator, and the live bar loop.
 * Exposes [start]/[stop] for the live feed and [runBacktest] for historical simulation.
 */
class TraderService(
    alpacaKey: String,
    alpacaSecret: String,
    private val paper: Boolean = true,
    private val startingEquity: Double = 100_000.0,
    private val riskPct: Double = 0.005
) {
    private val log   = LoggerFactory.getLogger(TraderService::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val httpClient = HttpClient(CIO) {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        install(WebSockets)
    }

    private val alpacaHistorical = AlpacaHistoricalClient(httpClient, alpacaKey, alpacaSecret)
    private val alpacaStream     = AlpacaStreamClient(httpClient, alpacaKey, alpacaSecret)
    private val alpacaOrders     = AlpacaOrderClient(httpClient, alpacaKey, alpacaSecret, paper)
    private val yahooClient      = YahooFinanceClient(httpClient)
    private val macroDataService = MacroDataService(yahooClient, alpacaHistorical)
    private val orchestrator     = SignalOrchestrator()
    private val tradeManager     = TradeManager(alpacaOrders)
    private val volEngine        = VolatilityRegimeEngine()

    // Cached daily context (refreshed at 08:00 ET)
    @Volatile private var dailyBars: List<fi.lagrange.trader.data.model.DailyBar> = emptyList()
    @Volatile private var macroHistory: List<MacroSnapshot> = emptyList()
    @Volatile private var lastSignalReason: String = "not started"
    @Volatile private var macroResult: MacroRegimeResult? = null
    @Volatile private var accountEquity: Double = startingEquity
    @Volatile private var dailyPnl: Double = 0.0

    private var streamJob: Job? = null
    private val sessionBars5m = mutableListOf<Bar>()

    val isRunning: Boolean get() = streamJob?.isActive == true

    suspend fun start() {
        refreshDailyData()
        streamJob = scope.launch {
            alpacaStream.bars(listOf("SPY"))
                .onEach { bar -> onLiveBar(bar) }
                .catch { e -> lastSignalReason = "Stream error: ${e.message}" }
                .launchIn(this)
        }
    }

    fun stop() {
        streamJob?.cancel()
        streamJob = null
    }

    fun status(): TraderStatus {
        val macro = macroResult
        val macroSnap = macroHistory.lastOrNull()
        val volResult = macroSnap?.let { volEngine.compute(it) }
        return TraderStatus(
            running          = isRunning,
            accountEquity    = accountEquity,
            dailyPnl         = dailyPnl,
            hasOpenPosition  = tradeManager.hasOpenPosition,
            macroRegime      = macro?.regime?.name ?: "UNKNOWN",
            vixRegime        = volResult?.vixRegime?.name ?: "UNKNOWN",
            lastSignalReason = lastSignalReason
        )
    }

    suspend fun runBacktest(
        startDate: LocalDate,
        endDate: LocalDate,
        onProgress: (String) -> Unit = {}
    ): BacktestResult = coroutineScope {
        val start = startDate.toString()
        val end   = endDate.toString()
        log.info("Backtest starting: $start → $end")

        onProgress("Fetching market data in parallel...")
        val intradayD = async { alpacaHistorical.fetchBars("SPY", "5Min", start, end) }
        val dailyD    = async { alpacaHistorical.fetchDailyBars("SPY", "2010-01-01", end) }
        val macroD    = async { macroDataService.buildHistory("2010-01-01", end) }

        val intradayBars = intradayD.await().also {
            log.info("Backtest: fetched ${it.size} intraday bars")
            onProgress("Fetched ${it.size} SPY 5-min bars")
        }
        val daily = dailyD.await().also {
            log.info("Backtest: fetched ${it.size} daily bars")
            onProgress("Fetched ${it.size} daily bars")
        }
        val macro = macroD.await().also {
            log.info("Backtest: built ${it.size} macro snapshots")
            onProgress("Built ${it.size} macro snapshots — starting engine...")
        }

        val config = BacktestConfig(startDate, endDate, startingEquity, riskPct)
        val result = BacktestEngine(orchestrator).run(daily, intradayBars, macro, config, onProgress)
        log.info("Backtest done: ${result.trades.size} trades, finalEquity=${result.finalEquity}")
        result
    }

    private suspend fun refreshDailyData() {
        val today = Clock.System.now().toLocalDateTime(TimeZone.of("America/New_York")).date
        dailyBars    = alpacaHistorical.fetchDailyBars("SPY", "2010-01-01", today.toString())
        macroHistory = macroDataService.buildHistory("2010-01-01", today.toString())
        accountEquity = alpacaOrders.getAccountEquity().takeIf { it > 0 } ?: startingEquity
        sessionBars5m.clear()
    }

    private suspend fun onLiveBar(bar: Bar) {
        val etZone = TimeZone.of("America/New_York")
        val lt     = bar.timestamp.toLocalDateTime(etZone)
        val timeEt = LocalTime(lt.hour, lt.minute)
        val date   = lt.date

        // Refresh daily data at market open
        if (lt.hour == 9 && lt.minute == 30) {
            sessionBars5m.clear()
            refreshDailyData()
        }
        sessionBars5m.add(bar)

        // Let trade manager handle position management first
        val atr5 = computeAtr5()
        tradeManager.onBar(bar, atr5)

        // Evaluate signal for new entries
        if (!tradeManager.hasOpenPosition) {
            val input = OrchestratorInput(
                spyDailyBars    = dailyBars,
                spy5minBars     = sessionBars5m.toList(),
                macroHistory    = macroHistory,
                date            = date,
                timeEt          = timeEt,
                accountEquity   = accountEquity,
                riskPct         = riskPct,
                dailyPnl        = dailyPnl,
                hasOpenPosition = false
            )
            val signal = orchestrator.evaluate(input)
            lastSignalReason = signal.reason
            if (signal.direction == fi.lagrange.trader.signal.TradeDirection.LONG) {
                tradeManager.onSignal(signal)
            }
        }
    }

    private fun computeAtr5(): Double {
        if (sessionBars5m.size < 14) return 1.0
        val bars  = sessionBars5m.takeLast(50)
        val highs = bars.map { it.high }.toDoubleArray()
        val lows  = bars.map { it.low }.toDoubleArray()
        val closes = bars.map { it.close }.toDoubleArray()
        return Indicators.atr(highs, lows, closes, 14).lastOrNull { !it.isNaN() } ?: 1.0
    }
}
