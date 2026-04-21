package fi.lagrange.trader.signal

import fi.lagrange.trader.data.model.Bar
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlin.math.sqrt

data class OpeningRange(
    val high: Double,
    val low: Double,
    val range: Double    = high - low,
    val midpoint: Double = (high + low) / 2.0
)

data class OrbSetup(
    val orbDefined: Boolean,
    val openingRange: OpeningRange?,
    val breakoutDetected: Boolean,
    val breakoutBar: Bar?,
    // intraday indicator values at the breakout bar (or latest bar when no breakout yet)
    val vwap: Double,
    val vwapSigmaDistance: Double,   // (price − VWAP) / σ
    val priceAboveVwap: Boolean,
    val rvol: Double,
    val rsi14: Double,
    val macdHistogram: Double,
    val macdRising: Boolean,         // hist[i] > hist[i-1]
    val ema9: Double,
    val ema21: Double,
    val sma200: Double,
    val emaStackBull: Boolean,       // ema9 > ema21 > sma200
    // pre-evaluated gate conditions
    val orRangeValid: Boolean,       // [0.15, 1.0] × ATR14_daily
    val notOverextended: Boolean,    // close − OR_high ≤ 0.5 × ATR14_daily
    val reason: String = ""
)

class OrbSignal {

    private val etZone = TimeZone.of("America/New_York")

    /**
     * Analyses today's 5-minute intraday bars and returns an OrbSetup.
     *
     * [bars5min]  — all 5-min bars available for the session (09:30 ET onward).
     * [dailyAtr]  — ATR(14) on daily bars, used for range and extension checks.
     */
    fun analyze(bars5min: List<Bar>, dailyAtr: Double): OrbSetup {
        if (bars5min.isEmpty()) return empty("No bars provided")

        // Filter to regular session (09:30–16:00 ET)
        val session = bars5min.filter { bar ->
            val lt = bar.timestamp.toLocalDateTime(etZone)
            lt.hour > 9 || (lt.hour == 9 && lt.minute >= 30)
        }
        if (session.isEmpty()) return empty("No session bars")

        // Opening range = first 3 × 5-min bars (09:30–09:45)
        val orbBars = session.take(3)
        if (orbBars.size < 3) return empty("ORB window not yet complete")

        val orHigh = orbBars.maxOf { it.high }
        val orLow  = orbBars.minOf { it.low }
        val orRange = OpeningRange(orHigh, orLow)
        val orRangeValid = orRange.range >= 0.15 * dailyAtr && orRange.range <= 1.0 * dailyAtr

        if (session.size <= 3) return OrbSetup(
            orbDefined = true, openingRange = orRange, breakoutDetected = false, breakoutBar = null,
            vwap = 0.0, vwapSigmaDistance = 0.0, priceAboveVwap = false, rvol = 0.0,
            rsi14 = 0.0, macdHistogram = 0.0, macdRising = false,
            ema9 = 0.0, ema21 = 0.0, sma200 = 0.0, emaStackBull = false,
            orRangeValid = orRangeValid, notOverextended = false, reason = "Waiting for post-ORB bars"
        )

        // Compute indicators on full session array
        val closes  = session.map { it.close }.toDoubleArray()
        val volumes = session.map { it.volume }.toLongArray()

        val vwapArr    = computeVwap(session)
        val vwapSigArr = computeVwapSigma(session, vwapArr)
        val ema9Arr    = Indicators.ema(closes, 9)
        val ema21Arr   = Indicators.ema(closes, 21)
        val sma200Arr  = Indicators.sma(closes, 200)
        val rsiArr     = Indicators.rsi(closes, 14)
        val macd       = Indicators.macd(closes)
        val rvolArr    = Indicators.relativeVolume(volumes, 20)

        // Detect first 5-min bar close above OR_high after ORB window
        val breakIdx = (3 until session.size).firstOrNull { session[it].close > orHigh }

        val evalIdx = breakIdx ?: (session.size - 1)
        val bar     = session[evalIdx]

        val vwap     = vwapArr[evalIdx]
        val vwapSig  = vwapSigArr[evalIdx]
        val rvol     = rvolArr[evalIdx].takeIf { !it.isNaN() } ?: 0.0
        val rsi14    = rsiArr[evalIdx].takeIf { !it.isNaN() } ?: 50.0
        val macdHist = macd.histogram[evalIdx].takeIf { !it.isNaN() } ?: 0.0
        val macdRise = evalIdx >= 1 && macdHist > (macd.histogram[evalIdx - 1].takeIf { !it.isNaN() } ?: macdHist)
        val ema9     = ema9Arr[evalIdx]
        val ema21    = ema21Arr[evalIdx]
        val sma200   = sma200Arr[evalIdx].takeIf { !it.isNaN() } ?: 0.0
        val emaStack = !ema9.isNaN() && !ema21.isNaN() && ema9 > ema21 &&
                       (sma200 == 0.0 || ema21 > sma200)
        val notOvx   = if (breakIdx != null) bar.close - orHigh <= 0.5 * dailyAtr else false

        return OrbSetup(
            orbDefined       = true,
            openingRange     = orRange,
            breakoutDetected = breakIdx != null,
            breakoutBar      = if (breakIdx != null) bar else null,
            vwap             = vwap,
            vwapSigmaDistance = vwapSig,
            priceAboveVwap   = bar.close > vwap,
            rvol             = rvol,
            rsi14            = rsi14,
            macdHistogram    = macdHist,
            macdRising       = macdRise,
            ema9             = ema9,
            ema21            = ema21,
            sma200           = sma200,
            emaStackBull     = emaStack,
            orRangeValid     = orRangeValid,
            notOverextended  = notOvx,
            reason           = if (breakIdx != null) "Breakout at bar $breakIdx" else "No breakout yet"
        )
    }

    // Incremental session VWAP (resets at 09:30 each day)
    private fun computeVwap(bars: List<Bar>): DoubleArray {
        var cumPV = 0.0; var cumV = 0L
        return DoubleArray(bars.size) { i ->
            val b = bars[i]; val t = (b.high + b.low + b.close) / 3.0
            cumPV += t * b.volume; cumV += b.volume
            if (cumV > 0) cumPV / cumV else b.close
        }
    }

    // Rolling session σ of (typical price − VWAP), returns (price − vwap) / σ per bar
    private fun computeVwapSigma(bars: List<Bar>, vwapArr: DoubleArray): DoubleArray {
        var cumPV2 = 0.0; var cumV = 0L
        return DoubleArray(bars.size) { i ->
            val b  = bars[i]; val t = (b.high + b.low + b.close) / 3.0
            cumV  += b.volume
            cumPV2 += t * t * b.volume
            val variance = if (cumV > 0) cumPV2 / cumV - vwapArr[i] * vwapArr[i] else 0.0
            val sigma    = if (variance > 0) sqrt(variance) else 0.0
            if (sigma > 0) (b.close - vwapArr[i]) / sigma else 0.0
        }
    }

    private fun empty(reason: String) = OrbSetup(
        orbDefined = false, openingRange = null, breakoutDetected = false, breakoutBar = null,
        vwap = 0.0, vwapSigmaDistance = 0.0, priceAboveVwap = false, rvol = 0.0,
        rsi14 = 0.0, macdHistogram = 0.0, macdRising = false,
        ema9 = 0.0, ema21 = 0.0, sma200 = 0.0, emaStackBull = false,
        orRangeValid = false, notOverextended = false, reason = reason
    )
}
