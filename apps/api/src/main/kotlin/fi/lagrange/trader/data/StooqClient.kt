package fi.lagrange.trader.data

import fi.lagrange.trader.data.model.DailyBar
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.request.*
import kotlinx.datetime.LocalDate
import org.slf4j.LoggerFactory

// Fetches free daily OHLCV CSV data from Stooq — no API key required.
// Symbol examples: "^vix", "^vxv" (VIX3M), "^vvix", "uup" (DXY proxy)
class StooqClient(private val http: HttpClient) {

    private val log = LoggerFactory.getLogger(StooqClient::class.java)

    suspend fun fetchDailyBars(symbol: String): List<DailyBar> {
        val csv: String = http.get("https://stooq.com/q/d/l/") {
            parameter("s", symbol)
            parameter("i", "d")
            headers {
                append("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
                append("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
                append("Accept-Language", "en-US,en;q=0.5")
            }
        }.body()

        return csv.lines()
            .drop(1)
            .filter { it.isNotBlank() && !it.startsWith("No data") }
            .mapNotNull { line ->
                val p = line.split(",")
                if (p.size < 5) return@mapNotNull null
                runCatching {
                    DailyBar(
                        date   = LocalDate.parse(p[0]),
                        open   = p[1].toDouble(),
                        high   = p[2].toDouble(),
                        low    = p[3].toDouble(),
                        close  = p[4].toDouble(),
                        volume = p.getOrNull(5)?.toLongOrNull() ?: 0L
                    )
                }.getOrNull()
            }
            .sortedBy { it.date }
            .also { bars ->
                if (bars.isEmpty()) log.warn("Stooq returned 0 bars for $symbol — response head: ${csv.take(200)}")
                else log.info("Stooq $symbol: ${bars.size} bars (${bars.first().date}..${bars.last().date})")
            }
    }
}
