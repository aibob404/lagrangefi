package fi.lagrange.trader.execution

import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.request.*
import io.ktor.http.*
import kotlinx.serialization.json.*

data class AlpacaOrder(
    val id: String,
    val clientOrderId: String,
    val symbol: String,
    val qty: Int,
    val side: String,        // "buy" | "sell"
    val type: String,        // "market" | "limit"
    val status: String,      // "new" | "filled" | "canceled" | ...
    val filledQty: Int,
    val filledAvgPrice: Double?
)

data class AlpacaPosition(
    val symbol: String,
    val qty: Int,
    val avgEntryPrice: Double,
    val unrealizedPnl: Double,
    val marketValue: Double
)

/**
 * REST client for Alpaca paper-trading order management.
 * Paper endpoint: https://paper-api.alpaca.markets
 */
class AlpacaOrderClient(
    private val http: HttpClient,
    private val apiKey: String,
    private val apiSecret: String,
    private val paper: Boolean = true
) {
    private val base = if (paper) "https://paper-api.alpaca.markets" else "https://api.alpaca.markets"

    private fun HttpRequestBuilder.auth() {
        header("APCA-API-KEY-ID", apiKey)
        header("APCA-API-SECRET-KEY", apiSecret)
    }

    // --- Orders ---

    suspend fun marketBuy(symbol: String, qty: Int, clientId: String = ""): AlpacaOrder {
        val body = buildJsonObject {
            put("symbol", symbol)
            put("qty", qty)
            put("side", "buy")
            put("type", "market")
            put("time_in_force", "day")
            if (clientId.isNotBlank()) put("client_order_id", clientId)
        }
        val resp: JsonObject = http.post("$base/v2/orders") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }.body()
        return parseOrder(resp)
    }

    suspend fun marketSell(symbol: String, qty: Int, clientId: String = ""): AlpacaOrder {
        val body = buildJsonObject {
            put("symbol", symbol)
            put("qty", qty)
            put("side", "sell")
            put("type", "market")
            put("time_in_force", "day")
            if (clientId.isNotBlank()) put("client_order_id", clientId)
        }
        val resp: JsonObject = http.post("$base/v2/orders") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }.body()
        return parseOrder(resp)
    }

    suspend fun limitSell(symbol: String, qty: Int, limitPrice: Double, clientId: String = ""): AlpacaOrder {
        val body = buildJsonObject {
            put("symbol", symbol)
            put("qty", qty)
            put("side", "sell")
            put("type", "limit")
            put("time_in_force", "day")
            put("limit_price", limitPrice)
            if (clientId.isNotBlank()) put("client_order_id", clientId)
        }
        val resp: JsonObject = http.post("$base/v2/orders") {
            auth()
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }.body()
        return parseOrder(resp)
    }

    suspend fun cancelOrder(orderId: String) {
        http.delete("$base/v2/orders/$orderId") { auth() }
    }

    suspend fun cancelAllOrders() {
        http.delete("$base/v2/orders") { auth() }
    }

    suspend fun getOrder(orderId: String): AlpacaOrder {
        val resp: JsonObject = http.get("$base/v2/orders/$orderId") { auth() }.body()
        return parseOrder(resp)
    }

    // --- Positions ---

    suspend fun getPosition(symbol: String): AlpacaPosition? = runCatching {
        val resp: JsonObject = http.get("$base/v2/positions/$symbol") { auth() }.body()
        parsePosition(resp)
    }.getOrNull()

    suspend fun getAllPositions(): List<AlpacaPosition> {
        val arr: JsonArray = http.get("$base/v2/positions") { auth() }.body()
        return arr.mapNotNull { runCatching { parsePosition(it.jsonObject) }.getOrNull() }
    }

    suspend fun closeAllPositions() {
        http.delete("$base/v2/positions") {
            auth()
            parameter("cancel_orders", true)
        }
    }

    // --- Account ---

    suspend fun getAccountEquity(): Double {
        val resp: JsonObject = http.get("$base/v2/account") { auth() }.body()
        return resp["equity"]?.jsonPrimitive?.doubleOrNull ?: 0.0
    }

    // --- Parsers ---

    private fun parseOrder(o: JsonObject) = AlpacaOrder(
        id              = o["id"]!!.jsonPrimitive.content,
        clientOrderId   = o["client_order_id"]?.jsonPrimitive?.content ?: "",
        symbol          = o["symbol"]!!.jsonPrimitive.content,
        qty             = o["qty"]?.jsonPrimitive?.intOrNull ?: 0,
        side            = o["side"]!!.jsonPrimitive.content,
        type            = o["type"]!!.jsonPrimitive.content,
        status          = o["status"]!!.jsonPrimitive.content,
        filledQty       = o["filled_qty"]?.jsonPrimitive?.intOrNull ?: 0,
        filledAvgPrice  = o["filled_avg_price"]?.jsonPrimitive?.doubleOrNull
    )

    private fun parsePosition(o: JsonObject) = AlpacaPosition(
        symbol          = o["symbol"]!!.jsonPrimitive.content,
        qty             = o["qty"]?.jsonPrimitive?.intOrNull ?: 0,
        avgEntryPrice   = o["avg_entry_price"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
        unrealizedPnl   = o["unrealized_pl"]?.jsonPrimitive?.doubleOrNull ?: 0.0,
        marketValue     = o["market_value"]?.jsonPrimitive?.doubleOrNull ?: 0.0
    )
}
