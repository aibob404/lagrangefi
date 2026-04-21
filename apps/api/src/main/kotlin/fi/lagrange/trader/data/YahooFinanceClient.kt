package fi.lagrange.trader.data

import fi.lagrange.trader.data.model.DailyBar
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.request.*
import kotlinx.datetime.TimeZone
import kotlinx.datetime.atStartOfDayIn
import kotlinx.datetime.toLocalDateTime
import kotlinx.datetime.LocalDate
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import kotlinx.serialization.json.*
import org.slf4j.LoggerFactory

/**
 * Fetches daily OHLCV from Yahoo Finance — no API key required.
 * Symbols: ^VIX, ^VXV (VIX3M), ^VVIX, ^TNX (10Y yield %), ^IRX (13W T-bill %)
 *          and ETFs like HYG, LQD, SPY.
 */
class YahooFinanceClient(private val http: HttpClient) {

    private val log = LoggerFactory.getLogger(YahooFinanceClient::class.java)

    suspend fun fetchDailyBars(symbol: String, startDate: String = "2010-01-01"): List<DailyBar> {
        val period1 = LocalDate.parse(startDate).atStartOfDayIn(TimeZone.UTC).epochSeconds
        val period2 = Clock.System.now().epochSeconds

        val response: JsonObject = http.get("https://query1.finance.yahoo.com/v8/finance/chart/$symbol") {
            parameter("interval", "1d")
            parameter("period1", period1)
            parameter("period2", period2)
            headers {
                append("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
                append("Accept", "application/json")
            }
        }.body()

        val result = response["chart"]?.jsonObject
            ?.get("result")?.jsonArray
            ?.firstOrNull()?.jsonObject
            ?: run { log.warn("Yahoo Finance: no result for $symbol"); return emptyList() }

        val timestamps = result["timestamp"]?.jsonArray ?: return emptyList()
        val quote = result["indicators"]?.jsonObject
            ?.get("quote")?.jsonArray
            ?.firstOrNull()?.jsonObject
            ?: return emptyList()

        val opens  = quote["open"]?.jsonArray
        val highs  = quote["high"]?.jsonArray
        val lows   = quote["low"]?.jsonArray
        val closes = quote["close"]?.jsonArray
        val vols   = quote["volume"]?.jsonArray

        val bars = timestamps.indices.mapNotNull { i ->
            val close = closes?.getOrNull(i)?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
            val ts    = timestamps[i].jsonPrimitive.long
            val date  = Instant.fromEpochSeconds(ts).toLocalDateTime(TimeZone.UTC).date
            DailyBar(
                date   = date,
                open   = opens?.getOrNull(i)?.jsonPrimitive?.doubleOrNull ?: close,
                high   = highs?.getOrNull(i)?.jsonPrimitive?.doubleOrNull ?: close,
                low    = lows?.getOrNull(i)?.jsonPrimitive?.doubleOrNull ?: close,
                close  = close,
                volume = vols?.getOrNull(i)?.jsonPrimitive?.longOrNull ?: 0L
            )
        }.sortedBy { it.date }

        if (bars.isEmpty()) log.warn("Yahoo Finance returned 0 bars for $symbol")
        else log.info("Yahoo Finance $symbol: ${bars.size} bars (${bars.first().date}..${bars.last().date})")
        return bars
    }
}
