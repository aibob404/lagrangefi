package fi.lagrange.trader.data

import fi.lagrange.trader.data.model.DailyBar
import fi.lagrange.trader.data.model.MacroSnapshot

/**
 * Assembles daily [MacroSnapshot] rows — no API key required.
 *  - Yahoo Finance: ^VIX, ^VXV (VIX3M), ^VVIX, ^TNX (10Y yield), ^IRX (13W T-bill / FFR proxy)
 *  - Alpaca or Yahoo Finance ETF prices: HYG, LQD
 *
 * Gaps (holidays) are forward-filled from the most recent known value.
 */
class MacroDataService(
    private val yahoo: YahooFinanceClient,
    private val alpaca: AlpacaHistoricalClient
) {

    suspend fun buildHistory(startDate: String = "2010-01-01", endDate: String): List<MacroSnapshot> {
        val tnx   = yahoo.fetchDailyBars("^TNX", startDate).associateBy { it.date }  // 10Y yield %
        val irx   = yahoo.fetchDailyBars("^IRX", startDate).associateBy { it.date }  // 13W T-bill %
        val vix   = yahoo.fetchDailyBars("^VIX", startDate).associateBy { it.date }
        val vix3m = yahoo.fetchDailyBars("^VXV", startDate).associateBy { it.date }
        val vvix  = yahoo.fetchDailyBars("^VVIX", startDate).associateBy { it.date }
        val hyg   = fetchEtf("HYG", startDate, endDate).associateBy { it.date }
        val lqd   = fetchEtf("LQD", startDate, endDate).associateBy { it.date }

        val allDates = vix.keys.filter { it.toString() >= startDate && it.toString() <= endDate }.sorted()

        var lastTnx = 0.0; var lastIrx = 0.0
        var lastHyg = 0.0; var lastLqd = 0.0
        var lastVix3m = 0.0; var lastVvix = 0.0

        return allDates.mapNotNull { date ->
            tnx[date]?.let   { lastTnx   = it.close }
            irx[date]?.let   { lastIrx   = it.close }
            hyg[date]?.let   { lastHyg   = it.close }
            lqd[date]?.let   { lastLqd   = it.close }
            vix3m[date]?.let { lastVix3m = it.close }
            vvix[date]?.let  { lastVvix  = it.close }

            val vixClose = vix[date]?.close ?: return@mapNotNull null
            if (lastTnx == 0.0) return@mapNotNull null

            MacroSnapshot(
                date         = date,
                fedFundsRate = lastIrx,
                yield10y     = lastTnx,
                yield3m      = lastIrx,
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
            runCatching { yahoo.fetchDailyBars(symbol, start) }.getOrDefault(emptyList())
        }
}
