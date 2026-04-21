package fi.lagrange.trader.data

import fi.lagrange.trader.data.model.DailyBar
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.request.*
import kotlinx.datetime.LocalDate

// Fetches free daily OHLCV CSV data from Stooq — no API key required.
// Symbol examples: "^vix", "^vxv" (VIX3M), "^vvix", "uup" (DXY proxy)
class StooqClient(private val http: HttpClient) {

    suspend fun fetchDailyBars(symbol: String): List<DailyBar> {
        val csv: String = http.get("https://stooq.com/q/d/l/") {
            parameter("s", symbol)
            parameter("i", "d")
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
    }
}
