package fi.lagrange.trader.data

import fi.lagrange.trader.data.model.DailyBar
import fi.lagrange.trader.data.model.MacroSnapshot
import kotlinx.datetime.LocalDate

/**
 * Assembles daily [MacroSnapshot] rows by joining:
 *  - FRED series: Fed Funds Rate, 2Y/10Y/3M Treasury yields
 *  - Stooq free CSV: VIX (^vix), VIX3M (^vxv), VVIX (^vvix)
 *  - Alpaca or Stooq ETF prices: HYG, LQD
 *
 * Gaps (e.g. holidays where FRED has no data) are forward-filled from the
 * most recent known value.
 */
class MacroDataService(
    private val fred: FredClient,
    private val stooq: StooqClient,
    private val alpaca: AlpacaHistoricalClient
) {

    suspend fun buildHistory(startDate: String = "2014-01-01", endDate: String): List<MacroSnapshot> {
        // Fetch all series concurrently would be ideal with coroutines, but sequentially is safe
        val ffr    = fred.fetch("DFEDTARU", startDate).associateBy { it.date }
        val y2     = fred.fetch("DGS2",     startDate).associateBy { it.date }
        val y10    = fred.fetch("DGS10",    startDate).associateBy { it.date }
        val y3m    = fred.fetch("DGS3MO",   startDate).associateBy { it.date }
        val vix    = stooq.fetchDailyBars("^vix").associateBy { it.date }
        val vix3m  = stooq.fetchDailyBars("^vxv").associateBy { it.date }
        val vvix   = stooq.fetchDailyBars("^vvix").associateBy { it.date }
        val hyg    = fetchEtf("HYG", startDate, endDate).associateBy { it.date }
        val lqd    = fetchEtf("LQD", startDate, endDate).associateBy { it.date }

        // Build a sorted set of all dates where we have at least VIX data
        val allDates = vix.keys.filter { it.toString() >= startDate && it.toString() <= endDate }.sorted()

        var lastFfr   = 0.0; var lastY2  = 0.0; var lastY10  = 0.0; var lastY3m = 0.0
        var lastHyg   = 0.0; var lastLqd  = 0.0
        var lastVix3m = 0.0; var lastVvix = 0.0

        return allDates.mapNotNull { date ->
            // Forward-fill missing FRED values (FRED does not publish on weekends/holidays)
            ffr[date]?.let { lastFfr    = it.value }
            y2[date]?.let  { lastY2     = it.value }
            y10[date]?.let { lastY10    = it.value }
            y3m[date]?.let { lastY3m    = it.value }
            hyg[date]?.let { lastHyg    = it.close }
            lqd[date]?.let { lastLqd    = it.close }
            vix3m[date]?.let { lastVix3m = it.close }
            vvix[date]?.let  { lastVvix  = it.close }

            val vixClose = vix[date]?.close ?: return@mapNotNull null  // skip if no VIX data
            if (lastFfr == 0.0 || lastY10 == 0.0) return@mapNotNull null  // insufficient data

            MacroSnapshot(
                date         = date,
                fedFundsRate = lastFfr,
                yield2y      = lastY2,
                yield10y     = lastY10,
                yield3m      = lastY3m,
                hygClose     = lastHyg,
                lqdClose     = lastLqd,
                vixClose     = vixClose,
                vix3mClose   = lastVix3m,
                vvixClose    = lastVvix
            )
        }
    }

    private suspend fun fetchEtf(symbol: String, start: String, end: String): List<DailyBar> =
        runCatching { alpaca.fetchDailyBars(symbol, start, end) }.getOrElse {
            // Fall back to Stooq if Alpaca fails (Stooq covers HYG/LQD)
            runCatching { stooq.fetchDailyBars(symbol.lowercase()) }.getOrDefault(emptyList())
        }
}
