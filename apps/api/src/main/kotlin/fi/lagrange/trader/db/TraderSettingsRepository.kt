package fi.lagrange.trader.db

import fi.lagrange.model.TraderSettings
import fi.lagrange.model.TraderTrades
import fi.lagrange.trader.data.model.CompletedTrade
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.datetime.Clock
import kotlinx.datetime.toJavaInstant
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.kotlin.datetime.timestamp
import org.jetbrains.exposed.sql.transactions.transaction

data class TraderSettingsRow(
    val userId: Int,
    val encryptedApiKey: String,
    val encryptedApiSecret: String,
    val paper: Boolean,
    val startingEquity: Double,
    val riskPct: Double
)

class TraderSettingsRepository {

    fun get(userId: Int): TraderSettingsRow? = transaction {
        TraderSettings.selectAll().where { TraderSettings.userId eq userId }.singleOrNull()?.let {
            TraderSettingsRow(
                userId            = it[TraderSettings.userId],
                encryptedApiKey   = it[TraderSettings.encryptedApiKey],
                encryptedApiSecret = it[TraderSettings.encryptedApiSecret],
                paper             = it[TraderSettings.paper],
                startingEquity    = it[TraderSettings.startingEquity],
                riskPct           = it[TraderSettings.riskPct]
            )
        }
    }

    fun upsert(row: TraderSettingsRow) = transaction {
        val now = Clock.System.now()
        val exists = TraderSettings.selectAll().where { TraderSettings.userId eq row.userId }.count() > 0
        if (exists) {
            TraderSettings.update({ TraderSettings.userId eq row.userId }) {
                it[encryptedApiKey]    = row.encryptedApiKey
                it[encryptedApiSecret] = row.encryptedApiSecret
                it[paper]              = row.paper
                it[startingEquity]     = row.startingEquity
                it[riskPct]            = row.riskPct
                it[updatedAt]          = now
            }
        } else {
            TraderSettings.insert {
                it[userId]             = row.userId
                it[encryptedApiKey]    = row.encryptedApiKey
                it[encryptedApiSecret] = row.encryptedApiSecret
                it[paper]              = row.paper
                it[startingEquity]     = row.startingEquity
                it[riskPct]            = row.riskPct
                it[updatedAt]          = now
            }
        }
    }

    fun saveTrade(userId: Int, trade: CompletedTrade) = transaction {
        val lastExit = trade.exits.lastOrNull()
        TraderTrades.insert {
            it[TraderTrades.userId]       = userId
            it[entryAt]                   = trade.entry.timestamp
            it[exitAt]                    = lastExit?.timestamp
            it[entryPrice]                = trade.entry.price
            it[exitPrice]                 = lastExit?.price
            it[shares]                    = trade.entry.shares
            it[pnl]                       = trade.pnl
            it[pnlPct]                    = trade.pnlPct
            it[holdMinutes]               = trade.holdMinutes
            it[qualityScore]              = trade.entry.qualityScore
            it[macroScore]                = trade.entry.macroScore
            it[exitReason]                = lastExit?.reason?.name
            it[reason]                    = trade.entry.reason
            it[createdAt]                 = Clock.System.now()
        }
    }

    fun listTrades(userId: Int, limit: Int = 100): List<ResultRow> = transaction {
        TraderTrades.selectAll()
            .where { TraderTrades.userId eq userId }
            .orderBy(TraderTrades.entryAt, SortOrder.DESC)
            .limit(limit)
            .toList()
    }
}
