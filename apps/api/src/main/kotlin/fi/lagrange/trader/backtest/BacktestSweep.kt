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

    // SPY buy-and-hold baseline
    val holdBars = dailyBars.filter { it.date >= LocalDate.parse(startDate) && it.date <= LocalDate.parse(endDate) }
    val holdReturn = if (holdBars.size >= 2) (holdBars.last().close - holdBars.first().close) / holdBars.first().close else 0.0
    val holdYears  = 4.0
    val holdCagr   = Math.pow(1.0 + holdReturn, 1.0 / holdYears) - 1.0

    println("Data: ${intradayBars.size} 5-min | ${dailyBars.size} daily | ${macroHistory.size} macro")
    println("SPY buy-and-hold: ${String.format("%+.1f%%", holdReturn * 100)} total  ${String.format("%+.1f%%", holdCagr * 100)} CAGR\n")
    http.close()

    val backtestConfig = BacktestConfig(
        startDate      = LocalDate.parse(startDate),
        endDate        = LocalDate.parse(endDate),
        startingEquity = 100_000.0,
        riskPct        = 0.005
    )

    // --- Gate rejection funnel (M≥0, retest) ---
    println("Analysing gate rejection funnel (M≥0, retest entry)...")
    val rejections = mutableMapOf<String, Int>()
    BacktestEngine(SignalOrchestrator(SignalConfig(macroGate = 0, retestEntry = true)), MacroRegimeEngine())
        .run(dailyBars, intradayBars, macroHistory, backtestConfig, onEval = { signal ->
            if (signal.direction == TradeDirection.NONE) {
                val gate = signal.reason.substringBefore(":").trim()
                rejections[gate] = (rejections[gate] ?: 0) + 1
            }
        })
    val total = rejections.values.sum().toDouble()
    println("Gate rejection funnel (${total.toInt()} non-trade evaluations):")
    rejections.entries.sortedByDescending { it.value }.forEach { (gate, count) ->
        println("  %-45s %7d  (%4.1f%%)".format(gate, count, count / total * 100))
    }
    println()

    // --- Parameter sweep ---
    val configs: List<Pair<String, SignalConfig>> = listOf(
        // Baseline (no retest) — reference points
        "Chase  M≥2  RVOL1.5 stop×0.50"   to SignalConfig(macroGate = 2, rvolMin = 1.5, stopAtrMult = 0.50),
        "Chase  M≥1  RVOL1.5 stop×0.50"   to SignalConfig(macroGate = 1, rvolMin = 1.5, stopAtrMult = 0.50),
        "Chase  M≥0  RVOL1.5 stop×0.50"   to SignalConfig(macroGate = 0, rvolMin = 1.5, stopAtrMult = 0.50),

        // Retest entry (core hypothesis)
        "Retest M≥2  RVOL1.5 stop×0.50"   to SignalConfig(macroGate = 2, rvolMin = 1.5, stopAtrMult = 0.50, retestEntry = true),
        "Retest M≥1  RVOL1.5 stop×0.50"   to SignalConfig(macroGate = 1, rvolMin = 1.5, stopAtrMult = 0.50, retestEntry = true),
        "Retest M≥0  RVOL1.5 stop×0.50"   to SignalConfig(macroGate = 0, rvolMin = 1.5, stopAtrMult = 0.50, retestEntry = true),

        // Retest + looser RVOL
        "Retest M≥2  RVOL1.2 stop×0.50"   to SignalConfig(macroGate = 2, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true),
        "Retest M≥1  RVOL1.2 stop×0.50"   to SignalConfig(macroGate = 1, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true),
        "Retest M≥0  RVOL1.2 stop×0.50"   to SignalConfig(macroGate = 0, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true),

        // Retest + wider RSI window
        "Retest M≥2  RVOL1.2 RSI45-75"    to SignalConfig(macroGate = 2, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0),
        "Retest M≥1  RVOL1.2 RSI45-75"    to SignalConfig(macroGate = 1, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0),
        "Retest M≥0  RVOL1.2 RSI45-75"    to SignalConfig(macroGate = 0, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0),

        // Retest + no MACD filter
        "Retest M≥2  noMACD  RSI45-75"     to SignalConfig(macroGate = 2, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0, requireMacd = false),
        "Retest M≥1  noMACD  RSI45-75"     to SignalConfig(macroGate = 1, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0, requireMacd = false),
        "Retest M≥0  noMACD  RSI45-75"     to SignalConfig(macroGate = 0, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0, requireMacd = false),

        // Retest + wider stop (give trades more room)
        "Retest M≥1  RVOL1.2 stop×0.75"   to SignalConfig(macroGate = 1, rvolMin = 1.2, stopAtrMult = 0.75, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0, requireMacd = false),
        "Retest M≥0  RVOL1.2 stop×0.75"   to SignalConfig(macroGate = 0, rvolMin = 1.2, stopAtrMult = 0.75, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0, requireMacd = false),

        // Diagnostic: force-short everything (no long gate, no RVOL filter)
        "DIAG: short-only no gate no RVOL" to SignalConfig(macroGate = 100, rvolMin = 0.0, stopAtrMult = 0.50, allowShorts = true, shortMacroGate = 100),

        // Bidirectional: long when bullish macro, short when bearish
        "Chase  L≥2/S≤-1 RVOL1.5"         to SignalConfig(macroGate = 2, rvolMin = 1.5, stopAtrMult = 0.50, allowShorts = true, shortMacroGate = -1),
        "Chase  L≥1/S≤-1 RVOL1.5"         to SignalConfig(macroGate = 1, rvolMin = 1.5, stopAtrMult = 0.50, allowShorts = true, shortMacroGate = -1),
        "Chase  L≥2/S≤-2 RVOL1.5"         to SignalConfig(macroGate = 2, rvolMin = 1.5, stopAtrMult = 0.50, allowShorts = true, shortMacroGate = -2),
        "Retest L≥2/S≤-1 RVOL1.2 RSI45-75" to SignalConfig(macroGate = 2, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0, allowShorts = true, shortMacroGate = -1),
        "Retest L≥1/S≤-1 RVOL1.2 RSI45-75" to SignalConfig(macroGate = 1, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0, allowShorts = true, shortMacroGate = -1),
        "Retest L≥2/S≤-1 noMACD"           to SignalConfig(macroGate = 2, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0, requireMacd = false, allowShorts = true, shortMacroGate = -1),
        "Retest L≥1/S≤-1 noMACD"           to SignalConfig(macroGate = 1, rvolMin = 1.2, stopAtrMult = 0.50, retestEntry = true, rsiMin = 45.0, rsiMax = 75.0, requireMacd = false, allowShorts = true, shortMacroGate = -1),
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

    val col = "%-40s"
    val hdr = "$col %6s %5s %6s %6s %7s %7s %6s".format(
        "Config", "Trades", "Win%", "PF", "Sharpe", "MaxDD%", "Net%", "CAGR%"
    )
    println(hdr)
    println("─".repeat(hdr.length))

    // SPY hold row
    println("$col %6s %5s %6s %6s %6s%% %6s%% %5s%%".format(
        "★ SPY buy-and-hold", "-", "-", "-", "-",
        String.format("%.1f", 0.0),
        String.format("%.2f", holdReturn * 100),
        String.format("%.2f", holdCagr * 100)
    ))
    println("─".repeat(hdr.length))

    for ((label, r) in results) {
        val beatsHold = r.annualisedReturn > holdCagr
        val marker = if (beatsHold) "★" else " "
        println("$marker$col %6d %4.1f%% %6.2f %6.2f %6.1f%% %6.2f%% %5.2f%%".format(
            label, r.totalTrades, r.winRate * 100, r.profitFactor,
            r.sharpe, r.maxDrawdownPct * 100, r.netReturn * 100, r.annualisedReturn * 100
        ))
    }

    val winners = results.filter { (_, r) -> r.annualisedReturn > holdCagr }
    println("\n${winners.size}/${configs.size} configs beat SPY buy-and-hold (${String.format("%.1f%%", holdCagr * 100)} CAGR)")
}
