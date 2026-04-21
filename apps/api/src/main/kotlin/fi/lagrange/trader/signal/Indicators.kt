package fi.lagrange.trader.signal

import fi.lagrange.trader.data.model.Bar
import kotlin.math.*

object Indicators {

    fun sma(values: DoubleArray, period: Int): DoubleArray {
        val out = DoubleArray(values.size) { Double.NaN }
        for (i in period - 1 until values.size) {
            out[i] = values.slice(i - period + 1..i).average()
        }
        return out
    }

    fun ema(values: DoubleArray, period: Int): DoubleArray {
        val out = DoubleArray(values.size) { Double.NaN }
        if (values.size < period) return out
        val k = 2.0 / (period + 1)
        var e = values.take(period).average()
        out[period - 1] = e
        for (i in period until values.size) {
            e = values[i] * k + e * (1 - k)
            out[i] = e
        }
        return out
    }

    fun atr(highs: DoubleArray, lows: DoubleArray, closes: DoubleArray, period: Int): DoubleArray {
        val out = DoubleArray(closes.size) { Double.NaN }
        if (closes.size < 2) return out
        val tr = DoubleArray(closes.size)
        tr[0] = highs[0] - lows[0]
        for (i in 1 until closes.size) {
            tr[i] = maxOf(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1]))
        }
        var atrVal = tr.slice(1..period).average()
        out[period] = atrVal
        for (i in period + 1 until closes.size) {
            atrVal = (atrVal * (period - 1) + tr[i]) / period
            out[i] = atrVal
        }
        return out
    }

    fun rsi(closes: DoubleArray, period: Int = 14): DoubleArray {
        val out = DoubleArray(closes.size) { Double.NaN }
        if (closes.size < period + 1) return out
        var avgGain = 0.0; var avgLoss = 0.0
        for (i in 1..period) {
            val d = closes[i] - closes[i-1]
            if (d > 0) avgGain += d else avgLoss -= d
        }
        avgGain /= period; avgLoss /= period
        out[period] = if (avgLoss == 0.0) 100.0 else 100.0 - 100.0 / (1.0 + avgGain / avgLoss)
        for (i in period + 1 until closes.size) {
            val d = closes[i] - closes[i-1]
            avgGain = (avgGain * (period - 1) + maxOf(d, 0.0)) / period
            avgLoss = (avgLoss * (period - 1) + maxOf(-d, 0.0)) / period
            out[i] = if (avgLoss == 0.0) 100.0 else 100.0 - 100.0 / (1.0 + avgGain / avgLoss)
        }
        return out
    }

    data class MacdResult(val line: DoubleArray, val signal: DoubleArray, val histogram: DoubleArray)

    fun macd(closes: DoubleArray, fast: Int = 12, slow: Int = 26, signal: Int = 9): MacdResult {
        val fastEma = ema(closes, fast)
        val slowEma = ema(closes, slow)
        val line = DoubleArray(closes.size) { i ->
            if (fastEma[i].isNaN() || slowEma[i].isNaN()) Double.NaN else fastEma[i] - slowEma[i]
        }
        val firstValid = line.indexOfFirst { !it.isNaN() }.takeIf { it >= 0 } ?: return MacdResult(line, line, line)
        val sigEma = ema(line.drop(firstValid).toDoubleArray(), signal)
        val sigLine = DoubleArray(closes.size) { Double.NaN }
        for (i in sigEma.indices) if (!sigEma[i].isNaN()) sigLine[firstValid + i] = sigEma[i]
        val hist = DoubleArray(closes.size) { i ->
            if (line[i].isNaN() || sigLine[i].isNaN()) Double.NaN else line[i] - sigLine[i]
        }
        return MacdResult(line, sigLine, hist)
    }

    data class AdxResult(val adx: DoubleArray, val plusDi: DoubleArray, val minusDi: DoubleArray)

    fun adx(highs: DoubleArray, lows: DoubleArray, closes: DoubleArray, period: Int = 14): AdxResult {
        val n = closes.size
        val adxOut = DoubleArray(n) { Double.NaN }
        val plusDiOut = DoubleArray(n) { Double.NaN }
        val minusDiOut = DoubleArray(n) { Double.NaN }
        if (n < period * 2) return AdxResult(adxOut, plusDiOut, minusDiOut)
        val plusDm = DoubleArray(n); val minusDm = DoubleArray(n); val tr = DoubleArray(n)
        for (i in 1 until n) {
            val hd = highs[i] - highs[i-1]; val ld = lows[i-1] - lows[i]
            plusDm[i]  = if (hd > ld && hd > 0) hd else 0.0
            minusDm[i] = if (ld > hd && ld > 0) ld else 0.0
            tr[i] = maxOf(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1]))
        }
        var sTr = tr.slice(1..period).sum()
        var sPlus = plusDm.slice(1..period).sum()
        var sMinus = minusDm.slice(1..period).sum()
        fun diP() = if (sTr > 0) 100.0 * sPlus / sTr else 0.0
        fun diM() = if (sTr > 0) 100.0 * sMinus / sTr else 0.0
        plusDiOut[period] = diP(); minusDiOut[period] = diM()
        var adxVal = if (diP() + diM() > 0) 100.0 * abs(diP() - diM()) / (diP() + diM()) else 0.0
        for (i in period + 1 until n) {
            sTr    = sTr    - sTr / period    + tr[i]
            sPlus  = sPlus  - sPlus / period  + plusDm[i]
            sMinus = sMinus - sMinus / period + minusDm[i]
            plusDiOut[i] = diP(); minusDiOut[i] = diM()
            val dx = if (diP() + diM() > 0) 100.0 * abs(diP() - diM()) / (diP() + diM()) else 0.0
            adxVal = (adxVal * (period - 1) + dx) / period
            adxOut[i] = adxVal
        }
        return AdxResult(adxOut, plusDiOut, minusDiOut)
    }

    data class VwapResult(val vwap: Double, val upper1: Double, val lower1: Double, val upper2: Double, val lower2: Double)

    fun sessionVwap(bars: List<Bar>): VwapResult {
        if (bars.isEmpty()) return VwapResult(0.0, 0.0, 0.0, 0.0, 0.0)
        var cumPV = 0.0; var cumV = 0L
        val typicals = mutableListOf<Double>()
        for (b in bars) { val t = b.typical; cumPV += t * b.volume; cumV += b.volume; typicals.add(t) }
        val vwap = if (cumV > 0) cumPV / cumV else bars.last().close
        val std = sqrt(typicals.map { (it - vwap).pow(2) }.average())
        return VwapResult(vwap, vwap + std, vwap - std, vwap + 2 * std, vwap - 2 * std)
    }

    fun linearRegressionSlope(values: DoubleArray): Double {
        val n = values.size.toDouble(); val xMean = (n - 1) / 2; val yMean = values.average()
        var num = 0.0; var den = 0.0
        for (i in values.indices) { num += (i - xMean) * (values[i] - yMean); den += (i - xMean).pow(2) }
        return if (den != 0.0) num / den else 0.0
    }

    fun zScore(values: DoubleArray, window: Int): DoubleArray {
        val out = DoubleArray(values.size) { Double.NaN }
        for (i in window - 1 until values.size) {
            val slice = values.slice(i - window + 1..i)
            val mean = slice.average()
            val std = sqrt(slice.map { (it - mean).pow(2) }.average())
            out[i] = if (std > 0) (values[i] - mean) / std else 0.0
        }
        return out
    }

    fun relativeVolume(volumes: LongArray, lookback: Int = 20): DoubleArray {
        val out = DoubleArray(volumes.size) { Double.NaN }
        for (i in lookback until volumes.size) {
            val avg = volumes.slice(i - lookback until i).average()
            out[i] = if (avg > 0) volumes[i] / avg else 1.0
        }
        return out
    }
}
