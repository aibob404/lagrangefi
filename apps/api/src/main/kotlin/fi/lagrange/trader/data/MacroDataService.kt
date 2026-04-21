package fi.lagrange.trader.data

import fi.lagrange.trader.data.model.DailyBar
import fi.lagrange.trader.data.model.MacroSnapshot
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

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

    suspend fun buildHistory(startDate: String = "2010-01-01", endDate: String): List<MacroSnapshot> = coroutineScope {
        val tnxD   = async { yahoo.fetchDailyBars("^TNX",  startDate).associateBy { it.date } }
        val irxD   = async { yahoo.fetchDailyBars("^IRX",  startDate).associateBy { it.date } }
        val vixD   = async { yahoo.fetchDailyBars("^VIX",  startDate).associateBy { it.date } }
        val vix3mD = async { yahoo.fetchDailyBars("^VXV",  startDate).associateBy { it.date } }
        val vvixD  = async { yahoo.fetchDailyBars("^VVIX", startDate).associateBy { it.date } }
        val hygD   = async { fetchEtf("HYG", startDate, endDate).associateBy { it.date } }
        val lqdD   = async { fetchEtf("LQD", startDate, endDate).associateBy { it.date } }

        val tnx   = tnxD.await()
        val irx   = irxD.await()
        val vix   = vixD.await()
        val vix3m = vix3mD.await()
        val vvix  = vvixD.await()
        val hyg   = hygD.await()
        val lqd   = lqdD.await()

        val allDates = vix.keys.filter { it.toString() >= startDate && it.toString() <= endDate }.sorted()

        var lastTnx = 0.0; var lastIrx = 0.0
        var lastHyg = 0.0; var lastLqd = 0.0
        var lastVix3m = 0.0; var lastVvix = 0.0

        allDates.mapNotNull { date ->
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
