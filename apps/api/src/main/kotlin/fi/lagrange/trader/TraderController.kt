package fi.lagrange.trader

import fi.lagrange.auth.getUserId
import fi.lagrange.model.BacktestRuns
import fi.lagrange.model.BacktestTrades
import fi.lagrange.trader.backtest.ReportGenerator
import fi.lagrange.trader.db.BacktestRepository
import fi.lagrange.trader.db.SecretEncryptor
import fi.lagrange.trader.db.TraderSettingsRepository
import fi.lagrange.trader.db.TraderSettingsRow
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.datetime.LocalDate
import kotlinx.serialization.Serializable
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@Serializable
data class TraderSettingsResponse(
    val paper: Boolean,
    val startingEquity: Double,
    val riskPct: Double,
    val alpacaKeySet: Boolean
)

@Serializable
data class SaveTraderSettingsRequest(
    val alpacaApiKey: String = "",
    val alpacaApiSecret: String = "",
    val paper: Boolean = true,
    val startingEquity: Double = 100_000.0,
    val riskPct: Double = 0.005
)

@Serializable
data class BacktestRequest(
    val startDate: String,
    val endDate: String
)

class BacktestJobState {
    @Volatile var status: String = "running"
    @Volatile var progress: String = "Starting..."
    @Volatile var result: BacktestReportDto? = null
    @Volatile var error: String? = null
}

@Serializable
data class BacktestJobStarted(val jobId: String)

@Serializable
data class BacktestJobResponse(
    val status: String,
    val progress: String,
    val result: BacktestReportDto? = null,
    val error: String? = null
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

@Serializable
data class BacktestRunSummaryDto(
    val id: Int,
    val startDate: String,
    val endDate: String,
    val ranAt: String,
    val startingEquity: Double,
    val totalTrades: Int,
    val winRate: Double,
    val profitFactor: Double,
    val sharpe: Double,
    val maxDrawdownPct: Double,
    val netReturnPct: Double,
    val annualisedReturnPct: Double
)

@Serializable
data class BacktestTradeDto(
    val id: Int,
    val entryAt: String,
    val exitAt: String?,
    val entryPrice: Double,
    val exitPrice: Double?,
    val shares: Int,
    val pnl: Double,
    val pnlPct: Double,
    val holdMinutes: Long,
    val rMultiple: Double,
    val qualityScore: Int,
    val macroScore: Int,
    val exitReason: String?,
    val entryReason: String
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
    val instances      = ConcurrentHashMap<Int, TraderService>()
    val backtestJobs   = ConcurrentHashMap<String, BacktestJobState>()
    val backtestScope  = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val backtestRepo   = BacktestRepository()

    route("/trader/spy-orb") {

        get("/settings") {
            val userId = call.getUserId()
            val row = settingsRepo.get(userId)
            if (row == null) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "No settings saved"))
                return@get
            }
            call.respond(TraderSettingsResponse(
                paper          = row.paper,
                startingEquity = row.startingEquity,
                riskPct        = row.riskPct,
                alpacaKeySet   = row.encryptedApiKey.isNotEmpty()
            ))
        }

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
            val existing = settingsRepo.get(userId)
            val encKey = if (body.alpacaApiKey.isNotBlank()) encryptor.encrypt(body.alpacaApiKey)
                         else existing?.encryptedApiKey ?: ""
            val encSecret = if (body.alpacaApiSecret.isNotBlank()) encryptor.encrypt(body.alpacaApiSecret)
                            else existing?.encryptedApiSecret ?: ""
            settingsRepo.upsert(TraderSettingsRow(
                userId             = userId,
                encryptedApiKey    = encKey,
                encryptedApiSecret = encSecret,
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

            val jobId = UUID.randomUUID().toString()
            val jobState = BacktestJobState()
            backtestJobs[jobId] = jobState

            backtestScope.launch {
                try {
                    val svc = TraderService(
                        alpacaKey      = encryptor.decrypt(row.encryptedApiKey),
                        alpacaSecret   = encryptor.decrypt(row.encryptedApiSecret),
                        paper          = row.paper,
                        startingEquity = row.startingEquity,
                        riskPct        = row.riskPct
                    )
                    val result = svc.runBacktest(startDate, endDate) { msg -> jobState.progress = msg }
                    val report = ReportGenerator.generate(result)

                    jobState.progress = "Saving results to database..."
                    val runId = backtestRepo.saveRun(userId, body.startDate, body.endDate, row.startingEquity, row.riskPct, report)
                    backtestRepo.saveTrades(runId, userId, result.trades)

                    jobState.result = BacktestReportDto(
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
                    )
                    jobState.status = "done"
                    jobState.progress = "Done"
                } catch (e: Exception) {
                    jobState.status = "error"
                    jobState.error = e.message ?: "Unknown error"
                }
            }

            call.respond(BacktestJobStarted(jobId = jobId))
        }

        get("/backtest/runs") {
            val userId = call.getUserId()
            val rows = backtestRepo.listRuns(userId)
            call.respond(rows.map { row ->
                BacktestRunSummaryDto(
                    id                  = row[BacktestRuns.id],
                    startDate           = row[BacktestRuns.startDate],
                    endDate             = row[BacktestRuns.endDate],
                    ranAt               = row[BacktestRuns.ranAt].toString(),
                    startingEquity      = row[BacktestRuns.startingEquity],
                    totalTrades         = row[BacktestRuns.totalTrades],
                    winRate             = row[BacktestRuns.winRate],
                    profitFactor        = row[BacktestRuns.profitFactor],
                    sharpe              = row[BacktestRuns.sharpe],
                    maxDrawdownPct      = row[BacktestRuns.maxDrawdownPct],
                    netReturnPct        = row[BacktestRuns.netReturnPct],
                    annualisedReturnPct = row[BacktestRuns.annualisedReturnPct]
                )
            })
        }

        get("/backtest/runs/{runId}/trades") {
            val userId = call.getUserId()
            val runId  = call.parameters["runId"]?.toIntOrNull()
                ?: run { call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Invalid runId")); return@get }
            val rows = backtestRepo.getTrades(runId, userId)
            call.respond(rows.map { row ->
                BacktestTradeDto(
                    id           = row[BacktestTrades.id],
                    entryAt      = row[BacktestTrades.entryAt].toString(),
                    exitAt       = row[BacktestTrades.exitAt]?.toString(),
                    entryPrice   = row[BacktestTrades.entryPrice],
                    exitPrice    = row[BacktestTrades.exitPrice],
                    shares       = row[BacktestTrades.shares],
                    pnl          = row[BacktestTrades.pnl],
                    pnlPct       = row[BacktestTrades.pnlPct],
                    holdMinutes  = row[BacktestTrades.holdMinutes],
                    rMultiple    = row[BacktestTrades.rMultiple],
                    qualityScore = row[BacktestTrades.qualityScore],
                    macroScore   = row[BacktestTrades.macroScore],
                    exitReason   = row[BacktestTrades.exitReason],
                    entryReason  = row[BacktestTrades.entryReason]
                )
            })
        }

        get("/backtest/{jobId}") {
            val jobId = call.parameters["jobId"]
                ?: run { call.respond(HttpStatusCode.BadRequest, mapOf("error" to "Missing jobId")); return@get }
            val job = backtestJobs[jobId]
                ?: run { call.respond(HttpStatusCode.NotFound, mapOf("error" to "Job not found")); return@get }
            call.respond(BacktestJobResponse(
                status   = job.status,
                progress = job.progress,
                result   = job.result,
                error    = job.error
            ))
        }
    }
}
