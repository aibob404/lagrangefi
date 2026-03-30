# DB Schema Redesign — Implementation Plan

## Context

You are implementing a DB schema redesign for `lagrangefi`, a Kotlin/Ktor + Exposed ORM application.
The project is a multi-user Uniswap v3 LP rebalancer on Arbitrum.

**Tech stack:**
- Kotlin + Ktor + Exposed ORM (PostgreSQL)
- All DB tables defined in a single file: `apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt`
- No migration framework — Exposed's `SchemaUtils.createMissingTablesAndColumns()` handles schema creation on startup
- All business logic in `apps/api/src/main/kotlin/fi/lagrange/`

**Read every file listed in each step before editing it. Do not guess at existing code.**

---

## Final Target Schema

This is the authoritative schema. Implement it exactly.

```
Users               id(PK), username(varchar64,unique), passwordHash(varchar128), createdAt
Wallets             id(PK), userId(FK→Users,unique), encryptedPhrase(text), createdAt, updatedAt
Strategies          id(PK), userId(FK→Users), name(varchar128), currentTokenId(varchar78),
                    token0(varchar42), token1(varchar42), fee(int),
                    token0Decimals(int,default 18), token1Decimals(int,default 6),
                    rangePercent(double,default 0.05), slippageTolerance(double,default 0.005),
                    pollIntervalSeconds(long,default 60),
                    status(varchar20,default "ACTIVE"),     -- INITIATING|ACTIVE|STOPPED_MANUALLY|STOPPED_ON_ERROR
                    createdAt, stoppedAt(nullable), stopReason(text,nullable),
                    initialToken0Amount(varchar78,nullable), initialToken1Amount(varchar78,nullable),
                    initialValueUsd(decimal(18,2),nullable), openEthPriceUsd(decimal(18,8),nullable),
                    endToken0Amount(varchar78,nullable), endToken1Amount(varchar78,nullable),
                    endValueUsd(decimal(18,2),nullable), endEthPriceUsd(decimal(18,8),nullable)

StrategyStats       strategyId(PK,FK→Strategies), totalRebalances(int,default 0),
                    feesCollectedToken0(varchar78,default "0"),
                    feesCollectedToken1(varchar78,default "0"),
                    gasCostWei(long,default 0),
                    gasCostUsd(decimal(18,2),default 0), feesCollectedUsd(decimal(18,2),default 0),
                    totalPollTicks(int,default 0), inRangeTicks(int,default 0),
                    timeInRangePct(double,default 0.0), updatedAt

StrategyEvents      id(PK), strategyId(FK→Strategies),
                    action(varchar32),   -- REBALANCE|START_STRATEGY|CLOSE_STRATEGY
                    idempotencyKey(varchar64,unique),
                    status(varchar20),   -- pending|success|failed
                    errorMessage(text,nullable), triggeredAt, completedAt(nullable)

RebalanceDetails    strategyEventId(PK,FK→StrategyEvents), strategyId(FK→Strategies),
                    oldNftTokenId(varchar78,nullable), newNftTokenId(varchar78,nullable),
                    newTickLower(int,NOT NULL), newTickUpper(int,NOT NULL),
                    feesCollectedToken0(varchar78,NOT NULL), feesCollectedToken1(varchar78,NOT NULL),
                    positionToken0Start(varchar78,NOT NULL), positionToken1Start(varchar78,NOT NULL),
                    positionToken0End(varchar78,NOT NULL), positionToken1End(varchar78,NOT NULL)

ChainTransactions   id(PK), strategyEventId(FK→StrategyEvents),
                    txHash(varchar66,unique),
                    action(varchar32),   -- COLLECT_FEES|BURN|APPROVE|SWAP|MINT|WITHDRAW_TO_WALLET|UNKNOWN
                    gasCostWei(long), ethToUsdPrice(decimal(18,8)), txTimestamp, createdAt

StrategySnapshots   id(PK), strategyId(FK→Strategies),
                    token0Amount(varchar78), token1Amount(varchar78),
                    valueUsd(decimal(18,2)), ethPriceUsd(decimal(18,8)), snapshotAt
```

**Key rules carried through all code changes:**
1. `StrategyStats` aggregates (`feesCollected*`, `gasCostWei`, `gasCostUsd`, `totalRebalances`) are ONLY updated when a `StrategyEvent` transitions to `status = "success"`. Never touch stats on `pending`.
2. `RebalanceDetails` is inserted ONLY when a rebalance StrategyEvent succeeds — all its non-nullable fields must be present on insert.
3. `ChainTransactions` and `RebalanceDetails` updates for a single event MUST happen in the same DB transaction as setting `StrategyEvent.status = "success"`.
4. `RebalanceDetails.strategyId` must always equal `StrategyEvents.strategyId` for the same `strategyEventId`. This is enforced by a DB trigger (see Step 2).

---

## Step 1 — Rewrite `Tables.kt`

**File:** `apps/api/src/main/kotlin/fi/lagrange/model/Tables.kt`

Replace the entire file. Keep `Users` and `Wallets` unchanged.

Replace `Strategies`, `StrategyStats`, `RebalanceEvents` with the following:

```kotlin
package fi.lagrange.model

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.kotlin.datetime.timestamp

object Users : Table("users") {
    val id = integer("id").autoIncrement()
    val username = varchar("username", 64).uniqueIndex()
    val passwordHash = varchar("password_hash", 128)
    val createdAt = timestamp("created_at")
    override val primaryKey = PrimaryKey(id)
}

object Wallets : Table("wallets") {
    val id = integer("id").autoIncrement()
    val userId = integer("user_id").references(Users.id).uniqueIndex()
    /** AES-256-GCM encrypted wallet phrase (mnemonic or private key), base64 encoded */
    val encryptedPhrase = text("encrypted_phrase")
    val createdAt = timestamp("created_at")
    val updatedAt = timestamp("updated_at")
    override val primaryKey = PrimaryKey(id)
}

object Strategies : Table("strategies") {
    val id = integer("id").autoIncrement()
    val userId = integer("user_id").references(Users.id)
    val name = varchar("name", 128)
    val currentTokenId = varchar("current_token_id", 78)
    val token0 = varchar("token0", 42)
    val token1 = varchar("token1", 42)
    val fee = integer("fee")
    val token0Decimals = integer("token0_decimals").default(18)
    val token1Decimals = integer("token1_decimals").default(6)
    val rangePercent = double("range_percent").default(0.05)
    val slippageTolerance = double("slippage_tolerance").default(0.005)
    val pollIntervalSeconds = long("poll_interval_seconds").default(60)
    /** INITIATING | ACTIVE | STOPPED_MANUALLY | STOPPED_ON_ERROR */
    val status = varchar("status", 20).default("ACTIVE")
    val createdAt = timestamp("created_at")
    val stoppedAt = timestamp("stopped_at").nullable()
    val stopReason = text("stop_reason").nullable()
    /** Open snapshot — recorded at strategy creation time */
    val initialToken0Amount = varchar("initial_token0_amount", 78).nullable()
    val initialToken1Amount = varchar("initial_token1_amount", 78).nullable()
    val initialValueUsd = decimal("initial_value_usd", 18, 2).nullable()
    val openEthPriceUsd = decimal("open_eth_price_usd", 18, 8).nullable()
    /** End snapshot — recorded when strategy is stopped */
    val endToken0Amount = varchar("end_token0_amount", 78).nullable()
    val endToken1Amount = varchar("end_token1_amount", 78).nullable()
    val endValueUsd = decimal("end_value_usd", 18, 2).nullable()
    val endEthPriceUsd = decimal("end_eth_price_usd", 18, 8).nullable()
    override val primaryKey = PrimaryKey(id)
}

object StrategyStats : Table("strategy_stats") {
    val strategyId = integer("strategy_id").references(Strategies.id)
    val totalRebalances = integer("total_rebalances").default(0)
    /** Raw token amounts as decimal strings (arbitrary precision ERC-20 values) */
    val feesCollectedToken0 = varchar("fees_collected_token0", 78).default("0")
    val feesCollectedToken1 = varchar("fees_collected_token1", 78).default("0")
    /** Total gas across all rebalances in wei (fits in Long: max ~9.2×10^18 wei) */
    val gasCostWei = long("gas_cost_wei").default(0L)
    val gasCostUsd = decimal("gas_cost_usd", 18, 2).default(java.math.BigDecimal.ZERO)
    val feesCollectedUsd = decimal("fees_collected_usd", 18, 2).default(java.math.BigDecimal.ZERO)
    val totalPollTicks = integer("total_poll_ticks").default(0)
    val inRangeTicks = integer("in_range_ticks").default(0)
    val timeInRangePct = double("time_in_range_pct").default(0.0)
    val updatedAt = timestamp("updated_at")
    override val primaryKey = PrimaryKey(strategyId)
}

object StrategyEvents : Table("strategy_events") {
    val id = integer("id").autoIncrement()
    val strategyId = integer("strategy_id").references(Strategies.id)
    /** REBALANCE | START_STRATEGY | CLOSE_STRATEGY */
    val action = varchar("action", 32)
    val idempotencyKey = varchar("idempotency_key", 64).uniqueIndex()
    /** pending | success | failed */
    val status = varchar("status", 20)
    val errorMessage = text("error_message").nullable()
    val triggeredAt = timestamp("triggered_at")
    val completedAt = timestamp("completed_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

object RebalanceDetails : Table("rebalance_details") {
    val strategyEventId = integer("strategy_event_id").references(StrategyEvents.id)
    /** Denormalized for query convenience. Must always equal StrategyEvents.strategyId for the same event. */
    val strategyId = integer("strategy_id").references(Strategies.id)
    val oldNftTokenId = varchar("old_nft_token_id", 78).nullable()
    val newNftTokenId = varchar("new_nft_token_id", 78).nullable()
    val newTickLower = integer("new_tick_lower")
    val newTickUpper = integer("new_tick_upper")
    val feesCollectedToken0 = varchar("fees_collected_token0", 78)
    val feesCollectedToken1 = varchar("fees_collected_token1", 78)
    val positionToken0Start = varchar("position_token0_start", 78)
    val positionToken1Start = varchar("position_token1_start", 78)
    val positionToken0End = varchar("position_token0_end", 78)
    val positionToken1End = varchar("position_token1_end", 78)
    override val primaryKey = PrimaryKey(strategyEventId)
}

object ChainTransactions : Table("chain_transactions") {
    val id = integer("id").autoIncrement()
    val strategyEventId = integer("strategy_event_id").references(StrategyEvents.id)
    val txHash = varchar("tx_hash", 66).uniqueIndex()
    /** COLLECT_FEES | BURN | APPROVE | SWAP | MINT | WITHDRAW_TO_WALLET | UNKNOWN */
    val action = varchar("action", 32)
    val gasCostWei = long("gas_cost_wei")
    val ethToUsdPrice = decimal("eth_to_usd_price", 18, 8)
    val txTimestamp = timestamp("tx_timestamp")
    val createdAt = timestamp("created_at")
    override val primaryKey = PrimaryKey(id)
}

object StrategySnapshots : Table("strategy_snapshots") {
    val id = integer("id").autoIncrement()
    val strategyId = integer("strategy_id").references(Strategies.id)
    val token0Amount = varchar("token0_amount", 78)
    val token1Amount = varchar("token1_amount", 78)
    val valueUsd = decimal("value_usd", 18, 2)
    val ethPriceUsd = decimal("eth_price_usd", 18, 8)
    val snapshotAt = timestamp("snapshot_at")
    override val primaryKey = PrimaryKey(id)
}
```

---

## Step 2 — Update `DatabaseConfig.kt`

**File:** `apps/api/src/main/kotlin/fi/lagrange/config/DatabaseConfig.kt`

1. Update imports: remove `RebalanceEvents`, add `StrategyEvents`, `RebalanceDetails`, `ChainTransactions`, `StrategySnapshots`.

2. Update `SchemaUtils.createMissingTablesAndColumns(...)` to include all new tables:
   ```kotlin
   SchemaUtils.createMissingTablesAndColumns(
       Users,
       Wallets,
       Strategies,
       StrategyStats,
       StrategyEvents,
       RebalanceDetails,
       ChainTransactions,
       StrategySnapshots,
   )
   ```

3. After `SchemaUtils`, add a raw SQL trigger to enforce `RebalanceDetails.strategyId` consistency:
   ```kotlin
   exec("""
       CREATE OR REPLACE FUNCTION check_rebalance_details_strategy_id()
       RETURNS TRIGGER AS $$
       BEGIN
           IF NEW.strategy_id != (SELECT strategy_id FROM strategy_events WHERE id = NEW.strategy_event_id) THEN
               RAISE EXCEPTION 'rebalance_details.strategy_id (%) does not match strategy_events.strategy_id for event_id=%',
                   NEW.strategy_id, NEW.strategy_event_id;
           END IF;
           RETURN NEW;
       END;
       $$ LANGUAGE plpgsql;

       DROP TRIGGER IF EXISTS trg_check_rebalance_details_strategy_id ON rebalance_details;
       CREATE TRIGGER trg_check_rebalance_details_strategy_id
       BEFORE INSERT OR UPDATE ON rebalance_details
       FOR EACH ROW EXECUTE FUNCTION check_rebalance_details_strategy_id();
   """.trimIndent())
   ```
   Use Exposed's `exec()` inside the existing `transaction {}` block.

---

## Step 3 — Update `ChainClient.kt`

**File:** `apps/api/src/main/kotlin/fi/lagrange/services/ChainClient.kt`

The chain service currently returns parallel arrays `txHashes: List<String>` and `txSteps: List<String>?`. Add a structured per-transaction type that the API will use to populate `ChainTransactions`.

1. Add a new data class `TxRecord` above `RebalanceResponse`:
   ```kotlin
   @Serializable
   data class TxRecord(
       val txHash: String,
       val action: String,     // maps to ChainTransactions.action enum values
       val gasUsedWei: Long = 0L,
   )
   ```

2. Add `txDetails: List<TxRecord>? = null` to `RebalanceResponse` (nullable for backward compatibility with existing chain service response):
   ```kotlin
   @Serializable
   data class RebalanceResponse(
       val success: Boolean,
       val txHashes: List<String>,
       val txSteps: List<String>? = null,
       val txDetails: List<TxRecord>? = null,   // ADD THIS
       val newTokenId: String? = null,
       val error: String? = null,
       val feesCollected: FeesCollectedResponse? = null,
       val gasUsedWei: String? = null,
       val positionToken0Start: String? = null,
       val positionToken1Start: String? = null,
       val positionToken0End: String? = null,
       val positionToken1End: String? = null,
       val isRecovery: Boolean? = null,
   )
   ```

3. Add `txDetails: List<TxRecord>? = null` to `CloseResponse` as well:
   ```kotlin
   @Serializable
   data class CloseResponse(
       val success: Boolean,
       val txHashes: List<String>,
       val txSteps: List<String>? = null,
       val txDetails: List<TxRecord>? = null,   // ADD THIS
       val token0Amount: String? = null,
       val token1Amount: String? = null,
       val error: String? = null,
   )
   ```

4. Add `gasUsedWei: Long? = null` to `MintResponse` (change from `String?` to `Long?` for type safety). Note: the existing field is `gasUsedWei: String?` — change it to `Long?` since it will be stored as `long` in the DB.

**Note:** The chain service (TypeScript) does not yet return `txDetails`. When `txDetails` is null, the code must fall back to constructing `TxRecord` list from the parallel `txHashes` + `txSteps` arrays with `gasUsedWei = 0L` per tx and total gas attributed to the last tx. This fallback is documented in Step 5.

---

## Step 4 — Rewrite DTOs and service methods in `StrategyService.kt`

**File:** `apps/api/src/main/kotlin/fi/lagrange/services/StrategyService.kt`

### 4a. Update imports
Remove `RebalanceEvents`. Add `StrategyEvents`, `RebalanceDetails`, `ChainTransactions`, `StrategySnapshots`.
Add `java.math.BigDecimal` import.

### 4b. Update `StrategyRecord`
- Remove `openTxHashes: String?`
- Change `initialValueUsd: Double?` → `initialValueUsd: java.math.BigDecimal?`
- Change `openEthPriceUsd: Double?` → `openEthPriceUsd: java.math.BigDecimal?`
- Add `stopReason: String?`
- Add `endToken0Amount: String?`, `endToken1Amount: String?`
- Add `endValueUsd: java.math.BigDecimal?`, `endEthPriceUsd: java.math.BigDecimal?`

### 4c. Update `StrategyStatsDto`
- Remove: `closeEthPriceUsd`, `closeFeesUsd`, `closeGasUsd`, `closeToken0Amount`, `closeToken1Amount`, `closeValueUsd`, `closeTxHashes`
- Change `gasCostWei: String` → `gasCostWei: Long`
- Change `gasCostUsd: Double` → `gasCostUsd: java.math.BigDecimal`
- Change `feesCollectedUsd: Double` → `feesCollectedUsd: java.math.BigDecimal`

### 4d. Replace `RebalanceEventDtoKt` with two new DTOs

```kotlin
@Serializable
data class ChainTransactionDto(
    val id: Int,
    val txHash: String,
    val action: String,
    val gasCostWei: Long,
    val ethToUsdPrice: java.math.BigDecimal,
    val txTimestamp: String,
    val createdAt: String,
)

@Serializable
data class StrategyEventDto(
    val id: Int,
    val strategyId: Int,
    val action: String,
    val status: String,
    val errorMessage: String?,
    val triggeredAt: String,
    val completedAt: String?,
    val rebalanceDetails: RebalanceDetailsDto?,
    val transactions: List<ChainTransactionDto>,
)

@Serializable
data class RebalanceDetailsDto(
    val oldNftTokenId: String?,
    val newNftTokenId: String?,
    val newTickLower: Int,
    val newTickUpper: Int,
    val feesCollectedToken0: String,
    val feesCollectedToken1: String,
    val positionToken0Start: String,
    val positionToken1Start: String,
    val positionToken0End: String,
    val positionToken1End: String,
)
```

### 4e. Update `rowToRecord()`
- Remove `openTxHashes`
- Change `initialValueUsd` and `openEthPriceUsd` to read from `decimal` columns (Exposed returns `BigDecimal` for `decimal()` columns)
- Add `stopReason`, `endToken0Amount`, `endToken1Amount`, `endValueUsd`, `endEthPriceUsd`

### 4f. Update `create()`
- Remove `openTxHashes` parameter
- Change `initialValueUsd: Double?` → `java.math.BigDecimal?`
- Change `openEthPriceUsd: Double?` → `java.math.BigDecimal?`
- Remove `initialGasWei` parameter (gas is now recorded via ChainTransactions, not seeded into StrategyStats)
- Status on insert: `"ACTIVE"` (strategy is created after a successful mint — no INITIATING state in current flow)
- In `StrategyStats.insert {}` block: change `gasCostWei` initial value from string `"0"` to `0L`; set `gasCostUsd` and `feesCollectedUsd` to `BigDecimal.ZERO`
- Remove `it[Strategies.openTxHashes] = openTxHashes` line

### 4g. Update `stop()`
Add `stopReason: String? = null` and `isError: Boolean = false` parameters:
```kotlin
fun stop(strategyId: Int, userId: Int, stopReason: String? = null, isError: Boolean = false): Boolean = transaction {
    val now = Clock.System.now()
    val newStatus = if (isError) "STOPPED_ON_ERROR" else "STOPPED_MANUALLY"
    Strategies.update({
        (Strategies.id eq strategyId) and
        (Strategies.userId eq userId) and
        (Strategies.status neq "STOPPED_MANUALLY") and
        (Strategies.status neq "STOPPED_ON_ERROR")
    }) {
        it[status] = newStatus
        it[stoppedAt] = now
        it[Strategies.stopReason] = stopReason
    } > 0
}
```

### 4h. Replace `recordRebalanceSuccess()` with `recordRebalanceEvent()`

This method now receives structured data to populate `StrategyEvents`, `RebalanceDetails`, `ChainTransactions`, and `StrategyStats` — all in one transaction.

```kotlin
fun recordRebalanceEvent(
    strategyId: Int,
    eventId: Int,
    fees0: String,
    fees1: String,
    totalGasWei: Long,
    ethPriceUsd: java.math.BigDecimal,
    txRecords: List<fi.lagrange.services.TxRecord>,   // from ChainClient
    oldNftTokenId: String?,
    newNftTokenId: String?,
    newTickLower: Int,
    newTickUpper: Int,
    positionToken0Start: String,
    positionToken1Start: String,
    positionToken0End: String,
    positionToken1End: String,
) = transaction {
    val now = Clock.System.now()

    // 1. Update StrategyEvent to success
    StrategyEvents.update({ StrategyEvents.id eq eventId }) {
        it[status] = "success"
        it[completedAt] = now
    }

    // 2. Insert RebalanceDetails (all fields required)
    RebalanceDetails.insert {
        it[RebalanceDetails.strategyEventId] = eventId
        it[RebalanceDetails.strategyId] = strategyId
        it[RebalanceDetails.oldNftTokenId] = oldNftTokenId
        it[RebalanceDetails.newNftTokenId] = newNftTokenId
        it[RebalanceDetails.newTickLower] = newTickLower
        it[RebalanceDetails.newTickUpper] = newTickUpper
        it[feesCollectedToken0] = fees0
        it[feesCollectedToken1] = fees1
        it[RebalanceDetails.positionToken0Start] = positionToken0Start
        it[RebalanceDetails.positionToken1Start] = positionToken1Start
        it[RebalanceDetails.positionToken0End] = positionToken0End
        it[RebalanceDetails.positionToken1End] = positionToken1End
    }

    // 3. Insert one ChainTransaction per tx
    for (tx in txRecords) {
        ChainTransactions.insert {
            it[strategyEventId] = eventId
            it[txHash] = tx.txHash
            it[action] = tx.action
            it[gasCostWei] = tx.gasUsedWei
            it[ethToUsdPrice] = ethPriceUsd
            it[txTimestamp] = now   // ideally from chain, use now() as fallback
            it[createdAt] = now
        }
    }

    // 4. Accumulate StrategyStats — only on success, never on pending
    val statsRow = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
        ?: return@transaction

    val newFees0 = (statsRow[StrategyStats.feesCollectedToken0].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
            (fees0.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
    val newFees1 = (statsRow[StrategyStats.feesCollectedToken1].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
            (fees1.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
    val newGasWei = statsRow[StrategyStats.gasCostWei] + totalGasWei

    val gasEth = java.math.BigDecimal(totalGasWei).divide(java.math.BigDecimal("1000000000000000000"), 18, java.math.RoundingMode.HALF_UP)
    val newGasUsd = statsRow[StrategyStats.gasCostUsd] + gasEth.multiply(ethPriceUsd).setScale(2, java.math.RoundingMode.HALF_UP)

    val strategy = Strategies.selectAll().where { Strategies.id eq strategyId }.firstOrNull()
    val dec0 = strategy?.get(Strategies.token0Decimals) ?: 18
    val dec1 = strategy?.get(Strategies.token1Decimals) ?: 6
    val fee0 = (fees0.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
        .toBigDecimal().divide(java.math.BigDecimal.TEN.pow(dec0), dec0, java.math.RoundingMode.HALF_UP)
    val fee1 = (fees1.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
        .toBigDecimal().divide(java.math.BigDecimal.TEN.pow(dec1), dec1, java.math.RoundingMode.HALF_UP)
    val feesUsdNew = if (dec0 == 18)
        fee0.multiply(ethPriceUsd).add(fee1).setScale(2, java.math.RoundingMode.HALF_UP)
    else
        fee1.multiply(ethPriceUsd).add(fee0).setScale(2, java.math.RoundingMode.HALF_UP)
    val newFeesUsd = statsRow[StrategyStats.feesCollectedUsd] + feesUsdNew

    StrategyStats.update({ StrategyStats.strategyId eq strategyId }) {
        it[totalRebalances] = statsRow[StrategyStats.totalRebalances] + 1
        it[feesCollectedToken0] = newFees0.toString()
        it[feesCollectedToken1] = newFees1.toString()
        it[gasCostWei] = newGasWei
        it[gasCostUsd] = newGasUsd
        it[feesCollectedUsd] = newFeesUsd
        it[updatedAt] = now
    }
}
```

Remove the old `recordRebalanceSuccess()` method entirely.

### 4i. Replace `recordClose()` — write to `Strategies`, not `StrategyStats`

```kotlin
fun recordClose(
    strategyId: Int,
    endToken0Amount: String? = null,
    endToken1Amount: String? = null,
    endValueUsd: java.math.BigDecimal? = null,
    endEthPriceUsd: java.math.BigDecimal? = null,
) = transaction {
    Strategies.update({ Strategies.id eq strategyId }) {
        it[Strategies.endToken0Amount] = endToken0Amount
        it[Strategies.endToken1Amount] = endToken1Amount
        it[Strategies.endValueUsd] = endValueUsd
        it[Strategies.endEthPriceUsd] = endEthPriceUsd
    }
}
```

### 4j. Update `getStats()`
- Remove all `close*` fields from `StrategyStatsDto` construction
- Change `gasCostWei = stats[StrategyStats.gasCostWei]` — it is now a `Long`, not a String
- Change `gasCostUsd` and `feesCollectedUsd` — they are now `BigDecimal`

### 4k. Replace `getRebalanceHistory()` with `getEventHistory()`

Returns `List<StrategyEventDto>`. Join `StrategyEvents LEFT JOIN RebalanceDetails` and load `ChainTransactions` per event:

```kotlin
fun getEventHistory(strategyId: Int, userId: Int, limit: Int = 50): List<StrategyEventDto>? = transaction {
    Strategies.selectAll()
        .where { (Strategies.id eq strategyId) and (Strategies.userId eq userId) }
        .firstOrNull() ?: return@transaction null

    val events = StrategyEvents.selectAll()
        .where { StrategyEvents.strategyId eq strategyId }
        .orderBy(StrategyEvents.triggeredAt, SortOrder.DESC)
        .limit(limit)
        .toList()

    events.map { eventRow ->
        val eventId = eventRow[StrategyEvents.id]

        val details = RebalanceDetails.selectAll()
            .where { RebalanceDetails.strategyEventId eq eventId }
            .firstOrNull()?.let { d ->
                RebalanceDetailsDto(
                    oldNftTokenId = d[RebalanceDetails.oldNftTokenId],
                    newNftTokenId = d[RebalanceDetails.newNftTokenId],
                    newTickLower = d[RebalanceDetails.newTickLower],
                    newTickUpper = d[RebalanceDetails.newTickUpper],
                    feesCollectedToken0 = d[RebalanceDetails.feesCollectedToken0],
                    feesCollectedToken1 = d[RebalanceDetails.feesCollectedToken1],
                    positionToken0Start = d[RebalanceDetails.positionToken0Start],
                    positionToken1Start = d[RebalanceDetails.positionToken1Start],
                    positionToken0End = d[RebalanceDetails.positionToken0End],
                    positionToken1End = d[RebalanceDetails.positionToken1End],
                )
            }

        val txs = ChainTransactions.selectAll()
            .where { ChainTransactions.strategyEventId eq eventId }
            .orderBy(ChainTransactions.txTimestamp, SortOrder.ASC)
            .map { tx ->
                ChainTransactionDto(
                    id = tx[ChainTransactions.id],
                    txHash = tx[ChainTransactions.txHash],
                    action = tx[ChainTransactions.action],
                    gasCostWei = tx[ChainTransactions.gasCostWei],
                    ethToUsdPrice = tx[ChainTransactions.ethToUsdPrice],
                    txTimestamp = tx[ChainTransactions.txTimestamp].toString(),
                    createdAt = tx[ChainTransactions.createdAt].toString(),
                )
            }

        StrategyEventDto(
            id = eventId,
            strategyId = eventRow[StrategyEvents.strategyId],
            action = eventRow[StrategyEvents.action],
            status = eventRow[StrategyEvents.status],
            errorMessage = eventRow[StrategyEvents.errorMessage],
            triggeredAt = eventRow[StrategyEvents.triggeredAt].toString(),
            completedAt = eventRow[StrategyEvents.completedAt]?.toString(),
            rebalanceDetails = details,
            transactions = txs,
        )
    }
}
```

### 4l. Add `recordStrategySnapshot()`

```kotlin
fun recordStrategySnapshot(
    strategyId: Int,
    token0Amount: String,
    token1Amount: String,
    valueUsd: java.math.BigDecimal,
    ethPriceUsd: java.math.BigDecimal,
) = transaction {
    StrategySnapshots.insert {
        it[StrategySnapshots.strategyId] = strategyId
        it[StrategySnapshots.token0Amount] = token0Amount
        it[StrategySnapshots.token1Amount] = token1Amount
        it[StrategySnapshots.valueUsd] = valueUsd
        it[StrategySnapshots.ethPriceUsd] = ethPriceUsd
        it[snapshotAt] = Clock.System.now()
    }
}
```

---

## Step 5 — Rewrite `UniswapStrategy.kt`

**File:** `apps/api/src/main/kotlin/fi/lagrange/strategy/UniswapStrategy.kt`

### 5a. Update imports
Remove `RebalanceEvents`. Add `StrategyEvents`.

### 5b. Rewrite `execute()` — new event/tx recording flow

Replace the current `RebalanceEvents`-based flow with the new `StrategyEvents` + `RebalanceDetails` + `ChainTransactions` flow.

**New flow:**
1. Insert `StrategyEvents` row (action=`"REBALANCE"`, status=`"pending"`) — get back `eventId`
2. Call `chainClient.rebalance()`
3. **On success:** Call `strategyService.recordRebalanceEvent(...)` — this single call handles the full transaction (StrategyEvent→success, RebalanceDetails insert, ChainTransactions inserts, StrategyStats update)
4. **On failure:** In a single transaction, update `StrategyEvents` to `status="failed"` with `errorMessage` and `completedAt`

**Tx fallback logic for `txRecords`:** When `result.txDetails` is not null, use it directly as `List<TxRecord>`. When it is null, construct `TxRecord` list from parallel `result.txHashes` + `result.txSteps` arrays. Map step label strings to canonical action names (`"collect_fees"` → `"COLLECT_FEES"`, `"burn"` → `"BURN"`, `"approve"` → `"APPROVE"`, `"swap"` → `"SWAP"`, `"mint"` → `"MINT"`, `"withdraw"` → `"WITHDRAW_TO_WALLET"`, anything else → `"UNKNOWN"`). Distribute total `gasUsedWei` to the last tx in the list; set `0L` for all others.

**Snapshot after each rebalance success:** After `recordRebalanceEvent()`, call `strategyService.recordStrategySnapshot()` using `positionToken0End`, `positionToken1End`, and computed USD value. Use the same `ethPriceUsd` from poolState.

Replace `strategyService.recordRebalanceSuccess()` call with `strategyService.recordRebalanceEvent(...)`.

**Full rewritten `execute()` function:**

```kotlin
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
        } get StrategyEvents.id
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

            // Build TxRecord list — prefer txDetails if chain service provides them
            val txRecords: List<TxRecord> = if (result.txDetails != null) {
                result.txDetails
            } else {
                val hashes = result.txHashes
                val steps = result.txSteps ?: hashes.map { "UNKNOWN" }
                hashes.zip(steps).mapIndexed { idx, (hash, step) ->
                    val gas = if (idx == hashes.lastIndex) totalGasWei else 0L
                    TxRecord(
                        txHash = hash,
                        action = stepToAction(step),
                        gasUsedWei = gas,
                    )
                }
            }

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

            // Snapshot position state after successful rebalance
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

private fun stepToAction(step: String): String = when (step.lowercase()) {
    "collect_fees", "collectfees" -> "COLLECT_FEES"
    "burn" -> "BURN"
    "approve" -> "APPROVE"
    "swap" -> "SWAP"
    "mint" -> "MINT"
    "withdraw", "withdraw_to_wallet" -> "WITHDRAW_TO_WALLET"
    else -> "UNKNOWN"
}
```

Keep `calculateNewRange()` and `feeToTickSpacing()` unchanged.

---

## Step 6 — Update `StrategyScheduler.kt`

**File:** `apps/api/src/main/kotlin/fi/lagrange/strategy/StrategyScheduler.kt`

### 6a. Update `loadAndStartAll()` status filter
Change:
```kotlin
.where { Strategies.status eq "active" }
```
To:
```kotlin
.where { Strategies.status eq "ACTIVE" }
```

### 6b. Update `executeOnce()` status filter
Change:
```kotlin
.where { (Strategies.id eq strategyId) and (Strategies.status eq "active") }
```
To:
```kotlin
.where { (Strategies.id eq strategyId) and (Strategies.status eq "ACTIVE") }
```

### 6c. Update both `StrategyRecord` constructions (in `loadAndStartAll` and `executeOnce`)
- Remove `openTxHashes = row[Strategies.openTxHashes]`
- Add `stopReason = row[Strategies.stopReason]`
- Add `endToken0Amount = row[Strategies.endToken0Amount]`
- Add `endToken1Amount = row[Strategies.endToken1Amount]`
- Add `endValueUsd = row[Strategies.endValueUsd]`
- Add `endEthPriceUsd = row[Strategies.endEthPriceUsd]`
- Change `initialValueUsd` and `openEthPriceUsd` — these are now `BigDecimal` from decimal columns

---

## Step 7 — Update `Routing.kt`

**File:** `apps/api/src/main/kotlin/fi/lagrange/plugins/Routing.kt`

### 7a. `GET /position` and `GET /pool-state` — update status filter
Change `it.status == "active"` to `it.status == "ACTIVE"` in both routes.

### 7b. `POST /strategies/start` — update `strategyService.create()` call
- Remove `openTxHashes` argument
- Change `initialValueUsd` to `java.math.BigDecimal(initialValueUsd.toString()).setScale(2, java.math.RoundingMode.HALF_UP)` (was `Double`)
- Change `openEthPriceUsd` to `java.math.BigDecimal(ethPrice.toString()).setScale(8, java.math.RoundingMode.HALF_UP)` (was `Double`)
- Remove `initialGasWei` argument
- After creating the strategy, record a `START_STRATEGY` StrategyEvent + ChainTransactions for the mint tx:
  ```kotlin
  // Record START_STRATEGY event with mint transactions
  val startEventIdempotencyKey = "start-${strategy.id}-${mintResult.tokenId}"
  transaction {
      val startEventId = StrategyEvents.insert {
          it[strategyId] = strategy.id
          it[action] = "START_STRATEGY"
          it[idempotencyKey] = startEventIdempotencyKey
          it[status] = "success"
          it[triggeredAt] = Clock.System.now()
          it[completedAt] = Clock.System.now()
      } get StrategyEvents.id

      val mintEthPrice = java.math.BigDecimal(ethPrice.toString()).setScale(8, java.math.RoundingMode.HALF_UP)
      val mintGasLong = mintResult.gasUsedWei ?: 0L
      mintResult.txHashes.forEach { hash ->
          ChainTransactions.insert {
              it[strategyEventId] = startEventId
              it[txHash] = hash
              it[ChainTransactions.action] = "MINT"
              it[gasCostWei] = mintGasLong
              it[ethToUsdPrice] = mintEthPrice
              it[txTimestamp] = Clock.System.now()
              it[createdAt] = Clock.System.now()
          }
      }
  }
  ```
  Add the `StrategyEvents` and `ChainTransactions` imports to Routing.kt.

### 7c. `DELETE /strategies/{id}` — update `stop()` and `recordClose()`
- Pass `stopReason` from optional request body (add `val body = runCatching { call.receive<StopStrategyRequestDto>() }.getOrNull()` with a simple `@Serializable data class StopStrategyRequestDto(val reason: String? = null)`)
- Change `strategyService.stop(strategyId, userId)` to `strategyService.stop(strategyId, userId, stopReason = body?.reason, isError = false)`
- Update `strategyService.recordClose(...)` call — it now writes to `Strategies`, not `StrategyStats`. New signature:
  ```kotlin
  strategyService.recordClose(
      strategyId = strategyId,
      endToken0Amount = token0Amt,
      endToken1Amount = token1Amt,
      endValueUsd = closeValueUsd?.let { java.math.BigDecimal(it.toString()).setScale(2, java.math.RoundingMode.HALF_UP) },
      endEthPriceUsd = java.math.BigDecimal(closeEthPrice.toString()).setScale(8, java.math.RoundingMode.HALF_UP),
  )
  ```
- Remove the `closeTxHashes` argument (no longer stored)
- After a successful close, record a `CLOSE_STRATEGY` StrategyEvent + ChainTransactions from `closeResult.txDetails` / `closeResult.txHashes`. Follow the same fallback pattern as Step 5 for building `TxRecord` list, mapping `WITHDRAW_TO_WALLET` for close steps.

### 7d. `GET /strategies/{id}/rebalances` — rename to use `getEventHistory()`
Change `strategyService.getRebalanceHistory(strategyId, userId)` to `strategyService.getEventHistory(strategyId, userId)`.
The return type is now `List<StrategyEventDto>`.

### 7e. `GET /rebalances` (legacy route)
Same change: replace `getRebalanceHistory` with `getEventHistory`.

---

## Step 8 — Verify compilation

After all edits, run:
```bash
cd /workspace/lagrangefi/apps/api && ./gradlew compileKotlin
```

Fix any compilation errors. Common issues to watch for:
- `BigDecimal` vs `Double` mismatches at call sites
- `Long` vs `String` for `gasCostWei` fields
- Missing imports for new table objects
- `StrategyRecord` constructor calls in `StrategyScheduler` missing new fields

Do not change any TypeScript files (`apps/chain/`, `apps/web/`). Do not add logging, comments, or documentation beyond what exists. Do not refactor code that is not directly touched by these changes.
