package fi.lagrange.trader.data

import fi.lagrange.trader.data.model.DailyBar
import fi.lagrange.trader.data.model.MacroSnapshot

/**
 * Assembles daily [MacroSnapshot] rows — no API key required.
 *  - Stooq free CSV: ^tnx (10Y yield), ^irx (13W T-bill / FFR proxy), ^vix, ^vxv, ^vvix
 *  - Alpaca or Stooq ETF prices: HYG, LQD
 *
 * Gaps (holidays) are forward-filled from the most recent known value.
 */
class MacroDataService(
    private val stooq: StooqClient,
    private val alpaca: AlpacaHistoricalClient
) {

    suspend fun buildHistory(startDate: String = "2014-01-01", endDate: String): List<MacroSnapshot> {
        val tnx   = stooq.fetchDailyBars("^tnx").associateBy { it.date }   // 10Y Treasury yield
        val irx   = stooq.fetchDailyBars("^irx").associateBy { it.date }   // 13W T-bill (FFR proxy)
        val vix   = stooq.fetchDailyBars("^vix").associateBy { it.date }
        val vix3m = stooq.fetchDailyBars("^vxv").associateBy { it.date }
        val vvix  = stooq.fetchDailyBars("^vvix").associateBy { it.date }
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
            runCatching { stooq.fetchDailyBars(symbol.lowercase()) }.getOrDefault(emptyList())
        }
}
