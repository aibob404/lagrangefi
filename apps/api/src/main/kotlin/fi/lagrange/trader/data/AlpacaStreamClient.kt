package fi.lagrange.trader.data

import fi.lagrange.trader.data.model.Bar
import io.ktor.client.*
import io.ktor.client.plugins.websocket.*
import io.ktor.websocket.*
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.datetime.Instant
import kotlinx.serialization.json.*

/**
 * Streams real-time 1-minute and 5-minute bars from Alpaca's market data WebSocket.
 *
 * Endpoint: wss://stream.data.alpaca.markets/v2/iex  (free IEX feed)
 *
 * Auth message: {"action":"auth","key":"...","secret":"..."}
 * Subscribe:    {"action":"subscribe","bars":["SPY"]}
 * Each bar update: {"T":"b","S":"SPY","o":...,"h":...,"l":...,"c":...,"v":...,"t":...}
 */
class AlpacaStreamClient(
    private val http: HttpClient,
    private val apiKey: String,
    private val apiSecret: String,
    private val feed: String = "iex"
) {
    private val wsBase = "wss://stream.data.alpaca.markets/v2/$feed"

    /**
     * Returns a cold [Flow] of [Bar] events for [symbols].
     * Reconnects automatically on network errors via the caller's coroutine scope.
     *
     * Usage:
     * ```kotlin
     * streamClient.bars(listOf("SPY")).collect { bar -> orchestrator.onBar(bar) }
     * ```
     */
    fun bars(symbols: List<String>): Flow<Bar> = channelFlow {
        http.webSocket(wsBase) {
            // 1. Authenticate
            send(Frame.Text(buildJsonObject {
                put("action", "auth")
                put("key", apiKey)
                put("secret", apiSecret)
            }.toString()))

            // 2. Wait for auth confirmation
            awaitAuthConfirmation(incoming)

            // 3. Subscribe to bars
            send(Frame.Text(buildJsonObject {
                put("action", "subscribe")
                put("bars", buildJsonArray { symbols.forEach { add(it) } })
            }.toString()))

            // 4. Stream bar events
            for (frame in incoming) {
                if (frame !is Frame.Text) continue
                val text = frame.readText()
                val msgs = Json.parseToJsonElement(text).jsonArray
                for (msg in msgs) {
                    val obj = msg.jsonObject
                    if (obj["T"]?.jsonPrimitive?.content == "b") {
                        val bar = parseBar(obj) ?: continue
                        send(bar)
                    }
                }
            }
        }
    }

    private fun parseBar(obj: JsonObject): Bar? = runCatching {
        Bar(
            timestamp = Instant.parse(obj["t"]!!.jsonPrimitive.content),
            open      = obj["o"]!!.jsonPrimitive.double,
            high      = obj["h"]!!.jsonPrimitive.double,
            low       = obj["l"]!!.jsonPrimitive.double,
            close     = obj["c"]!!.jsonPrimitive.double,
            volume    = obj["v"]!!.jsonPrimitive.long,
            vwap      = obj["vw"]?.jsonPrimitive?.doubleOrNull ?: 0.0
        )
    }.getOrNull()

    private suspend fun awaitAuthConfirmation(incoming: ReceiveChannel<Frame>) {
        for (frame in incoming) {
            if (frame !is Frame.Text) continue
            val msgs = runCatching {
                Json.parseToJsonElement(frame.readText()).jsonArray
            }.getOrNull() ?: continue
            val authed = msgs.any { el ->
                val obj = el.jsonObject
                obj["T"]?.jsonPrimitive?.content == "success" &&
                obj["msg"]?.jsonPrimitive?.content == "authenticated"
            }
            if (authed) return
        }
        error("Alpaca WebSocket authentication failed")
    }
}
