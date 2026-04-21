package fi.lagrange.trader.backtest

import fi.lagrange.trader.data.AlpacaHistoricalClient
import fi.lagrange.trader.data.MacroDataService
import fi.lagrange.trader.data.YahooFinanceClient
import fi.lagrange.trader.data.model.Bar
import fi.lagrange.trader.data.model.DailyBar
import fi.lagrange.trader.data.model.MacroSnapshot
import fi.lagrange.trader.signal.MacroRegimeEngine
import fi.lagrange.trader.signal.SignalConfig
import fi.lagrange.trader.signal.SignalOrchestrator
import fi.lagrange.trader.signal.TradeDirection
import io.ktor.client.*
import io.ktor.client.engine.cio.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.coroutines.*
import kotlinx.datetime.LocalDate
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

// ── Disk cache ────────────────────────────────────────────────────────────────

private val cacheJson = Json { ignoreUnknownKeys = true }
private val cacheDir  = File(".backtestcache").also { it.mkdirs() }

private inline fun <reified T> cached(key: String, fetch: () -> T): T {
    val file = File(cacheDir, "$key.json")
    if (file.exists()) {
        println("  [cache] $key")
        return cacheJson.decodeFromString(file.readText())
    }
    val data = fetch()
    file.writeText(cacheJson.encodeToString(data))
    println("  [fetched + cached] $key")
    return data
}

// ── Main ──────────────────────────────────────────────────────────────────────

suspend fun main() {
    val alpacaKey    = System.getenv("ALPACA_KEY")    ?: error("Set ALPACA_KEY env var")
    val alpacaSecret = System.getenv("ALPACA_SECRET") ?: error("Set ALPACA_SECRET env var")
    val startDate    = System.getenv("START_DATE") ?: "2021-01-01"
    val endDate      = System.getenv("END_DATE")   ?: "2024-12-31"

    val http = HttpClient(CIO) {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
    }
    val alpaca = AlpacaHistoricalClient(http, alpacaKey, alpacaSecret)
    val yahoo  = YahooFinanceClient(http)
    val macro  = MacroDataService(yahoo, alpaca)

    println("Loading data for $startDate → $endDate ...")
    val intradayBars: List<Bar>
    val dailyBars: List<DailyBar>
    val macroHistory: List<MacroSnapshot>

    coroutineScope {
        val iD = async { cached("spy_5min_${startDate}_${endDate}") { alpaca.fetchBars("SPY", "5Min", startDate, endDate) } }
        val dD = async { cached("spy_daily_2010-01-01_${endDate}")  { alpaca.fetchDailyBars("SPY", "2010-01-01", endDate) } }
        val mD = async { cached("macro_2010-01-01_${endDate}")      { macro.buildHistory("2010-01-01", endDate) } }
        intradayBars = iD.await()
        dailyBars    = dD.await()
        macroHistory = mD.await()
    }
    println("Data: ${intradayBars.size} 5-min | ${dailyBars.size} daily | ${macroHistory.size} macro\n")
    http.close()

    val backtestConfig = BacktestConfig(
        startDate      = LocalDate.parse(startDate),
        endDate        = LocalDate.parse(endDate),
        startingEquity = 100_000.0,
        riskPct        = 0.005
    )

    // --- Gate rejection funnel (baseline M≥0) ---
    println("Analysing gate rejection funnel (M≥0 baseline)...")
    val rejections = mutableMapOf<String, Int>()
    BacktestEngine(SignalOrchestrator(SignalConfig(macroGate = 0)), MacroRegimeEngine())
        .run(dailyBars, intradayBars, macroHistory, backtestConfig, onEval = { signal ->
            if (signal.direction == TradeDirection.NONE) {
                val gate = signal.reason.substringBefore(":").trim()
                rejections[gate] = (rejections[gate] ?: 0) + 1
            }
        })
    val total = rejections.values.sum().toDouble()
    println("Gate rejection funnel (${total.toInt()} non-trade evaluations):")
    rejections.entries.sortedByDescending { it.value }.forEach { (gate, count) ->
        println("  %-40s %7d  (%4.1f%%)".format(gate, count, count / total * 100))
    }
    println()

    // --- Parameter sweep ---
    val configs: List<Pair<String, SignalConfig>> = listOf(
        "M≥-1 RVOL1.5 stop×0.50" to SignalConfig(macroGate = -1, rvolMin = 1.5, stopAtrMult = 0.50),
        "M≥0  RVOL1.5 stop×0.50" to SignalConfig(macroGate =  0, rvolMin = 1.5, stopAtrMult = 0.50),
        "M≥1  RVOL1.5 stop×0.50" to SignalConfig(macroGate =  1, rvolMin = 1.5, stopAtrMult = 0.50),
        "M≥2  RVOL1.5 stop×0.50" to SignalConfig(macroGate =  2, rvolMin = 1.5, stopAtrMult = 0.50),
        "M≥3  RVOL1.5 stop×0.50" to SignalConfig(macroGate =  3, rvolMin = 1.5, stopAtrMult = 0.50),
        "M≥4  RVOL1.5 stop×0.50" to SignalConfig(macroGate =  4, rvolMin = 1.5, stopAtrMult = 0.50),
        "M≥0  RVOL1.5 stop×0.75" to SignalConfig(macroGate =  0, rvolMin = 1.5, stopAtrMult = 0.75),
        "M≥1  RVOL1.5 stop×0.75" to SignalConfig(macroGate =  1, rvolMin = 1.5, stopAtrMult = 0.75),
        "M≥0  RVOL2.0 stop×0.50" to SignalConfig(macroGate =  0, rvolMin = 2.0, stopAtrMult = 0.50),
        "M≥1  RVOL2.0 stop×0.50" to SignalConfig(macroGate =  1, rvolMin = 2.0, stopAtrMult = 0.50),
    )

    println("Running ${configs.size} configs in parallel...\n")
    val results: List<Pair<String, BacktestReport>> = coroutineScope {
        configs.map { (label, sigConfig) ->
            async(Dispatchers.Default) {
                val engine = BacktestEngine(SignalOrchestrator(config = sigConfig), MacroRegimeEngine())
                val result = engine.run(dailyBars, intradayBars, macroHistory, backtestConfig)
                label to ReportGenerator.generate(result)
            }
        }.awaitAll()
    }

    val col = "%-26s"
    val hdr = "$col %6s %5s %6s %6s %7s %7s %6s".format(
        "Config", "Trades", "Win%", "PF", "Sharpe", "MaxDD%", "Net%", "CAGR%"
    )
    println(hdr)
    println("─".repeat(hdr.length))
    for ((label, r) in results) {
        println("$col %6d %4.1f%% %6.2f %6.2f %6.1f%% %6.2f%% %5.2f%%".format(
            label, r.totalTrades, r.winRate * 100, r.profitFactor,
            r.sharpe, r.maxDrawdownPct * 100, r.netReturn * 100, r.annualisedReturn * 100
        ))
    }
}
