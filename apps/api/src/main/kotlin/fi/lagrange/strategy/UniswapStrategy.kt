package fi.lagrange.strategy

import fi.lagrange.model.StrategyEvents
import fi.lagrange.services.ChainClient
import fi.lagrange.services.StrategyRecord
import fi.lagrange.services.StrategyService
import fi.lagrange.services.TelegramNotifier
import fi.lagrange.services.TxRecord
import kotlinx.datetime.Clock
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.jetbrains.exposed.sql.update
import org.slf4j.LoggerFactory
import java.util.UUID

/**
 * Executes one rebalance check/cycle for a single strategy.
 * No scheduler logic here — that lives in StrategyScheduler.
 */
class UniswapStrategy(
    private val chainClient: ChainClient,
    private val telegram: TelegramNotifier,
    private val strategyService: StrategyService,
) {
    private val log = LoggerFactory.getLogger(UniswapStrategy::class.java)

    /**
     * Run one poll cycle for the given strategy using the provided wallet phrase.
     * - Updates time-in-range stats every tick
     * - Triggers rebalance only when out of range
     */
    suspend fun execute(strategy: StrategyRecord, walletPhrase: String) {
        val tokenId = strategy.currentTokenId
        log.debug("Checking strategy=${strategy.id} user=${strategy.userId} tokenId=$tokenId")

        val position = chainClient.getPosition(tokenId)
        val poolState = chainClient.getPoolState(tokenId)

        val currentTick = poolState.tick
        val inRange = currentTick >= position.tickLower && currentTick < position.tickUpper

        strategyService.recordPollTick(strategy.id, inRange)

        if (inRange) {
            log.debug("Strategy=${strategy.id} in range (tick=$currentTick range=[${position.tickLower},${position.tickUpper}])")
            return
        }

        log.info("Strategy=${strategy.id} OUT OF RANGE — tick=$currentTick range=[${position.tickLower},${position.tickUpper}]. Rebalancing.")

        val hasPending = transaction {
            StrategyEvents.selectAll()
                .where { (StrategyEvents.strategyId eq strategy.id) and (StrategyEvents.status eq "pending") }
                .any()
        }
        if (hasPending) {
            log.warn("Strategy=${strategy.id} already has a pending rebalance event — skipping tick to avoid duplicate execution")
            return
        }

        telegram.sendAlert("[${strategy.name}] Out of range! tick=$currentTick range=[${position.tickLower},${position.tickUpper}]. Rebalancing...")

        val (newTickLower, newTickUpper) = calculateNewRange(currentTick, position.fee, strategy.rangePercent)
        val idempotencyKey = UUID.randomUUID().toString()
        val ethPrice = java.math.BigDecimal(poolState.price).setScale(8, java.math.RoundingMode.HALF_UP)

        val eventId = transaction {
            StrategyEvents.insert {
                it[strategyId] = strategy.id
                it[action] = "REBALANCE"
                it[StrategyEvents.idempotencyKey] = idempotencyKey
                it[status] = "pending"
                it[triggeredAt] = Clock.System.now()
            }[StrategyEvents.id]
        }

        try {
            val result = chainClient.rebalance(
                idempotencyKey = idempotencyKey,
                tokenId = tokenId,
                newTickLower = newTickLower,
                newTickUpper = newTickUpper,
                slippageTolerance = strategy.slippageTolerance,
                walletPrivateKey = walletPhrase,
            )

            if (result.success) {
                val recoveryNote = if (result.isRecovery == true) " (recovery)" else ""
                log.info("Strategy=${strategy.id} rebalance succeeded${recoveryNote}. newTokenId=${result.newTokenId}")
                telegram.sendAlert("[${strategy.name}] Rebalance successful${recoveryNote}! New tokenId=${result.newTokenId}")

                val fees0 = result.feesCollected?.amount0 ?: "0"
                val fees1 = result.feesCollected?.amount1 ?: "0"
                val totalGasWei = result.gasUsedWei?.toLongOrNull() ?: 0L

                val txRecords = buildTxRecords(result.txDetails, result.txHashes, result.txSteps, totalGasWei)

                strategyService.recordRebalanceEvent(
                    strategyId = strategy.id,
                    eventId = eventId,
                    fees0 = fees0,
                    fees1 = fees1,
                    totalGasWei = totalGasWei,
                    ethPriceUsd = ethPrice,
                    txRecords = txRecords,
                    oldNftTokenId = tokenId,
                    newNftTokenId = result.newTokenId,
                    newTickLower = newTickLower,
                    newTickUpper = newTickUpper,
                    positionToken0Start = result.positionToken0Start ?: "0",
                    positionToken1Start = result.positionToken1Start ?: "0",
                    positionToken0End = result.positionToken0End ?: "0",
                    positionToken1End = result.positionToken1End ?: "0",
                )

                result.newTokenId?.let { newId ->
                    strategyService.updateTokenId(strategy.id, newId)
                }

                // Snapshot position after successful rebalance
                val t0End = result.positionToken0End ?: "0"
                val t1End = result.positionToken1End ?: "0"
                val dec0 = strategy.token0Decimals
                val dec1 = strategy.token1Decimals
                val t0Human = (t0End.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
                    .toBigDecimal().divide(java.math.BigDecimal.TEN.pow(dec0), dec0, java.math.RoundingMode.HALF_UP)
                val t1Human = (t1End.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
                    .toBigDecimal().divide(java.math.BigDecimal.TEN.pow(dec1), dec1, java.math.RoundingMode.HALF_UP)
                val snapValueUsd = if (dec0 == 18)
                    t0Human.multiply(ethPrice).add(t1Human).setScale(2, java.math.RoundingMode.HALF_UP)
                else
                    t1Human.multiply(ethPrice).add(t0Human).setScale(2, java.math.RoundingMode.HALF_UP)
                strategyService.recordStrategySnapshot(strategy.id, t0End, t1End, snapValueUsd, ethPrice)

            } else {
                log.error("Strategy=${strategy.id} rebalance failed: ${result.error}")
                telegram.sendAlert("[${strategy.name}] Rebalance FAILED: ${result.error}")
                transaction {
                    StrategyEvents.update({ StrategyEvents.id eq eventId }) {
                        it[status] = "failed"
                        it[errorMessage] = result.error
                        it[completedAt] = Clock.System.now()
                    }
                }
            }
        } catch (e: Exception) {
            log.error("Strategy=${strategy.id} rebalance threw an exception", e)
            telegram.sendAlert("[${strategy.name}] Rebalance ERROR: ${e.message}")
            transaction {
                StrategyEvents.update({ StrategyEvents.id eq eventId }) {
                    it[status] = "failed"
                    it[errorMessage] = e.message
                    it[completedAt] = Clock.System.now()
                }
            }
            throw e
        }
    }

    private fun calculateNewRange(currentTick: Int, fee: Int, rangePercent: Double): Pair<Int, Int> {
        val tickSpacing = feeToTickSpacing(fee)
        val tickDelta = (Math.log(1.0 + rangePercent) / Math.log(1.0001)).toInt()
        val rawLower = currentTick - tickDelta
        val rawUpper = currentTick + tickDelta
        val tickLower = (rawLower / tickSpacing) * tickSpacing
        val tickUpper = (rawUpper / tickSpacing) * tickSpacing
        return Pair(tickLower, tickUpper)
    }

    private fun feeToTickSpacing(fee: Int): Int = when (fee) {
        100 -> 1
        500 -> 10
        3000 -> 60
        10000 -> 200
        else -> 60
    }
}

/**
 * Build TxRecord list from chain response.
 * Prefers txDetails if chain service provides them; falls back to parallel txHashes + txSteps arrays.
 * When falling back, total gas is attributed to the last tx; all others get 0.
 */
internal fun buildTxRecords(
    txDetails: List<TxRecord>?,
    txHashes: List<String>,
    txSteps: List<String>?,
    totalGasWei: Long,
): List<TxRecord> {
    if (txDetails != null) return txDetails
    val steps = txSteps ?: txHashes.map { "UNKNOWN" }
    return txHashes.zip(steps).mapIndexed { idx, (hash, step) ->
        TxRecord(
            txHash = hash,
            action = stepToAction(step),
            gasUsedWei = if (idx == txHashes.lastIndex) totalGasWei else 0L,
        )
    }
}

private fun stepToAction(step: String): String = when (step.lowercase()) {
    "collect_fees", "collectfees" -> "COLLECT_FEES"
    "burn" -> "BURN"
    "approve" -> "APPROVE"
    "swap" -> "SWAP"
    "mint" -> "MINT"
    "wrap" -> "WRAP"
    "withdraw", "withdraw_to_wallet" -> "WITHDRAW_TO_WALLET"
    else -> "UNKNOWN"
}
