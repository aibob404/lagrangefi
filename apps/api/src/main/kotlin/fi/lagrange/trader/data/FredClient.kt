package fi.lagrange.trader.data

import fi.lagrange.trader.data.model.FredSeries
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.request.*
import kotlinx.datetime.LocalDate
import kotlinx.serialization.json.*

class FredClient(
    private val http: HttpClient,
    private val apiKey: String
) {
    private val base = "https://api.stlouisfed.org/fred"

    suspend fun fetch(seriesId: String, startDate: String = "2014-01-01"): List<FredSeries> {
        val response: JsonObject = http.get("$base/series/observations") {
            parameter("series_id", seriesId)
            parameter("api_key", apiKey)
            parameter("file_type", "json")
            parameter("observation_start", startDate)
            parameter("sort_order", "asc")
        }.body()

        return response["observations"]?.jsonArray?.mapNotNull { el ->
            val o = el.jsonObject
            val v = o["value"]?.jsonPrimitive?.content ?: return@mapNotNull null
            if (v == ".") return@mapNotNull null
            FredSeries(LocalDate.parse(o["date"]!!.jsonPrimitive.content), v.toDouble())
        } ?: emptyList()
    }
}
