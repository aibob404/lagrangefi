package fi.lagrange.trader

import fi.lagrange.auth.getUserId
import fi.lagrange.trader.db.SecretEncryptor
import fi.lagrange.trader.db.TraderSettingsRepository
import fi.lagrange.trader.db.TraderSettingsRow
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.datetime.LocalDate
import kotlinx.serialization.Serializable
import java.util.concurrent.ConcurrentHashMap

@Serializable
data class SaveTraderSettingsRequest(
    val alpacaApiKey: String,
    val alpacaApiSecret: String,
    val paper: Boolean = true,
    val startingEquity: Double = 100_000.0,
    val riskPct: Double = 0.005
)

@Serializable
data class BacktestRequest(
    val startDate: String,
    val endDate: String
)

@Serializable
data class BacktestReportDto(
    val totalTrades: Int,
    val winRate: Double,
    val profitFactor: Double,
    val sharpe: Double,
    val sortino: Double,
    val maxDrawdownPct: Double,
    val netReturnPct: Double,
    val annualisedReturnPct: Double,
    val avgHoldMinutes: Double,
    val tradesPerWeek: Double,
    val summary: String
)

/**
 * Trader REST routes, mounted under /api/v1/trader.
 * Each user has their own Alpaca keys stored encrypted in the DB.
 * A [TraderService] instance is created on-demand per user and kept alive until /stop.
 *
 * GET  /status           — current trader state for this user
 * PUT  /settings         — save/update Alpaca + FRED credentials
 * POST /start            — start live bar stream
 * POST /stop             — stop live bar stream
 * POST /backtest         — run historical simulation (body: BacktestRequest)
 */
fun Route.traderRoutes(
    settingsRepo: TraderSettingsRepository,
    encryptor: SecretEncryptor
) {
    // In-memory registry of running trader instances, keyed by userId.
    // Production: replace with a persistent scheduler/supervisor approach.
    val instances = ConcurrentHashMap<Int, TraderService>()

    route("/trader/spy-orb") {

        get("/status") {
            val userId = call.getUserId()
            val svc = instances[userId]
            if (svc == null) {
                call.respond(TraderStatus(
                    running = false, accountEquity = 0.0, dailyPnl = 0.0,
                    hasOpenPosition = false, macroRegime = "UNKNOWN",
                    vixRegime = "UNKNOWN", lastSignalReason = "not started"
                ))
                return@get
            }
            call.respond(svc.status())
        }

        put("/settings") {
            val userId = call.getUserId()
            val body = call.receive<SaveTraderSettingsRequest>()
            settingsRepo.upsert(TraderSettingsRow(
                userId             = userId,
                encryptedApiKey    = encryptor.encrypt(body.alpacaApiKey),
                encryptedApiSecret = encryptor.encrypt(body.alpacaApiSecret),
                paper              = body.paper,
                startingEquity     = body.startingEquity,
                riskPct            = body.riskPct
            ))
            call.respond(mapOf("saved" to true))
        }

        post("/start") {
            val userId = call.getUserId()
            if (instances.containsKey(userId)) {
                call.respond(HttpStatusCode.Conflict, mapOf("error" to "Already running"))
                return@post
            }
            val row = settingsRepo.get(userId)
                ?: run {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "No trader settings saved — call PUT /trader/settings first"))
                    return@post
                }
            val svc = TraderService(
                alpacaKey      = encryptor.decrypt(row.encryptedApiKey),
                alpacaSecret   = encryptor.decrypt(row.encryptedApiSecret),
                paper          = row.paper,
                startingEquity = row.startingEquity,
                riskPct        = row.riskPct
            )
            instances[userId] = svc
            svc.start()
            call.respond(mapOf("started" to true))
        }

        post("/stop") {
            val userId = call.getUserId()
            instances.remove(userId)?.stop()
            call.respond(mapOf("stopped" to true))
        }

        post("/backtest") {
            val userId = call.getUserId()
            val body = call.receive<BacktestRequest>()
            val startDate = runCatching { LocalDate.parse(body.startDate) }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid startDate"))
                return@post
            }
            val endDate = runCatching { LocalDate.parse(body.endDate) }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid endDate"))
                return@post
            }
            val row = settingsRepo.get(userId)
                ?: run {
                    call.respond(HttpStatusCode.BadRequest, mapOf("error" to "No trader settings saved"))
                    return@post
                }
            val svc = TraderService(
                alpacaKey      = encryptor.decrypt(row.encryptedApiKey),
                alpacaSecret   = encryptor.decrypt(row.encryptedApiSecret),
                paper          = row.paper,
                startingEquity = row.startingEquity,
                riskPct        = row.riskPct
            )
            val report = svc.runBacktest(startDate, endDate)
            call.respond(BacktestReportDto(
                totalTrades         = report.totalTrades,
                winRate             = report.winRate,
                profitFactor        = report.profitFactor,
                sharpe              = report.sharpe,
                sortino             = report.sortino,
                maxDrawdownPct      = report.maxDrawdownPct,
                netReturnPct        = report.netReturn,
                annualisedReturnPct = report.annualisedReturn,
                avgHoldMinutes      = report.avgHoldMinutes,
                tradesPerWeek       = report.tradesPerWeek,
                summary             = report.summary()
            ))
        }
    }
}
