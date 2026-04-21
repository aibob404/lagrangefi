package fi.lagrange.trader.data

import fi.lagrange.trader.data.model.Bar
import fi.lagrange.trader.data.model.DailyBar
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.request.*
import kotlinx.datetime.Instant
import kotlinx.datetime.LocalDate
import kotlinx.serialization.json.*

class AlpacaHistoricalClient(
    private val http: HttpClient,
    private val apiKey: String,
    private val apiSecret: String
) {
    private val dataBase = "https://data.alpaca.markets"

    suspend fun fetchBars(
        symbol: String,
        timeframe: String,          // "1Min", "5Min", "1Day"
        start: String,              // ISO-8601 date string
        end: String,
        adjustment: String = "all",
        feed: String = "iex"
    ): List<Bar> {
        val bars = mutableListOf<Bar>()
        var nextToken: String? = null

        do {
            val response: JsonObject = http.get("$dataBase/v2/stocks/bars") {
                headers {
                    append("APCA-API-KEY-ID", apiKey)
                    append("APCA-API-SECRET-KEY", apiSecret)
                }
                parameter("symbols", symbol)
                parameter("timeframe", timeframe)
                parameter("start", start)
                parameter("end", end)
                parameter("limit", 10_000)
                parameter("adjustment", adjustment)
                parameter("feed", feed)
                parameter("sort", "asc")
                nextToken?.let { parameter("page_token", it) }
            }.body()

            val arr = response["bars"]?.jsonObject?.get(symbol)?.jsonArray ?: break
            arr.forEach { el ->
                val o = el.jsonObject
                bars.add(Bar(
                    timestamp = Instant.parse(o["t"]!!.jsonPrimitive.content),
                    open      = o["o"]!!.jsonPrimitive.double,
                    high      = o["h"]!!.jsonPrimitive.double,
                    low       = o["l"]!!.jsonPrimitive.double,
                    close     = o["c"]!!.jsonPrimitive.double,
                    volume    = o["v"]!!.jsonPrimitive.long,
                    vwap      = o["vw"]?.jsonPrimitive?.doubleOrNull ?: 0.0
                ))
            }
            nextToken = response["next_page_token"]?.jsonPrimitive?.contentOrNull
        } while (!nextToken.isNullOrEmpty())

        return bars
    }

    suspend fun fetchDailyBars(symbol: String, start: String, end: String): List<DailyBar> =
        fetchBars(symbol, "1Day", start, end, feed = "iex").map { bar ->
            val date = bar.timestamp.toString().substring(0, 10).let { LocalDate.parse(it) }
            DailyBar(date, bar.open, bar.high, bar.low, bar.close, bar.volume)
        }
}
