"""Python port of MacroRegimeEngine — produces daily mBase score in [-5, +5]."""
from __future__ import annotations

import numpy as np
import pandas as pd

from common import adx, load, load_close, sma


def build_panel() -> pd.DataFrame:
    """Construct a single daily panel with everything needed for the macro score."""
    spy = load("SPY")
    spy = spy[["High", "Low", "Close", "Adj Close"]].rename(
        columns={"High": "spy_high", "Low": "spy_low", "Close": "spy_close", "Adj Close": "spy_adj"}
    )

    # yields: yfinance reports these scaled by 100 (e.g. 4.25 = 4.25%)
    irx = load_close("IRX", "Close").rename("y3m")  # 13-week t-bill
    tnx = load_close("TNX", "Close").rename("y10y")
    fvx = load_close("FVX", "Close").rename("y5y")

    # credit
    hyg = load_close("HYG", "Adj Close").rename("hyg")
    lqd = load_close("LQD", "Adj Close").rename("lqd")

    # vol
    vix = load_close("VIX", "Close").rename("vix")

    df = spy.join([irx, tnx, fvx, hyg, lqd, vix], how="outer").sort_index()
    # forward-fill macro series (they may have different calendars) onto SPY trading days
    df = df.loc[spy.index]
    for col in ["y3m", "y10y", "y5y", "hyg", "lqd", "vix"]:
        df[col] = df[col].ffill()
    return df


def macro_score(panel: pd.DataFrame) -> pd.DataFrame:
    """Compute daily mBase and components. All columns aligned to SPY trading days."""
    out = pd.DataFrame(index=panel.index)

    price = panel["spy_close"]
    sma50 = sma(price, 50)
    sma200 = sma(price, 200)
    # SMA score: golden=+2, death=-2, else 0
    sma_score = pd.Series(0, index=panel.index, dtype=float)
    sma_score[(price > sma200) & (sma50 > sma200)] = 2.0
    sma_score[(price < sma200) & (sma50 < sma200)] = -2.0
    out["sma_score"] = sma_score

    # ADX + slope
    adx_vals = adx(panel["spy_high"], panel["spy_low"], price, 14)
    slope_abs = sma50.diff(20) / 20  # daily slope of sma50 over 20-day window
    slope_pct_ann = slope_abs / price * 252 * 100
    adx_score = pd.Series(0.0, index=panel.index)
    adx_score[(adx_vals >= 25) & (slope_pct_ann > 5.0)] = 1.0
    adx_score[(adx_vals < 20) | (slope_pct_ann < -5.0)] = -1.0
    out["adx_score"] = adx_score
    out["adx"] = adx_vals

    # Fed funds proxy: 3-month t-bill yield (IRX)
    ffr = panel["y3m"]
    ffr_score = pd.Series(0.0, index=panel.index)
    ffr_score[ffr < 2.0] = 2.0
    ffr_score[(ffr >= 2.0) & (ffr <= 4.0)] = 0.0
    ffr_score[(ffr > 4.0) & (ffr <= 5.5)] = -1.0
    ffr_score[ffr > 5.5] = -2.0
    out["ffr_score"] = ffr_score
    out["ffr"] = ffr

    # Yield curve (10Y - 3M)
    spread = panel["y10y"] - panel["y3m"]
    yield_score = pd.Series(0.0, index=panel.index)
    yield_score[spread > 1.0] = 1.0
    yield_score[(spread >= 0.0) & (spread <= 1.0)] = 0.0
    yield_score[(spread >= -0.5) & (spread < 0.0)] = -1.0
    yield_score[spread < -0.5] = -2.0
    out["yield_score"] = yield_score
    out["spread_10y_3m"] = spread

    # Credit spreads: HYG/LQD ratio z-score over 20d
    ratio = (panel["hyg"] / panel["lqd"]).replace([np.inf, -np.inf], np.nan)
    window = 20
    mu = ratio.rolling(window, min_periods=window).mean()
    sd = ratio.rolling(window, min_periods=window).std()
    z = (ratio - mu) / sd.replace(0, np.nan)
    credit_score = pd.Series(0.0, index=panel.index)
    credit_score[z > 1.0] = 1.0
    credit_score[(z <= 1.0) & (z >= -1.0)] = 0.0
    credit_score[(z < -1.0) & (z >= -2.0)] = -1.0
    credit_score[z < -2.0] = -2.0
    out["credit_score"] = credit_score
    out["credit_z"] = z

    mbase = (out["sma_score"] + out["adx_score"] + out["ffr_score"] +
             out["yield_score"] + out["credit_score"]).clip(-5, 5)
    out["mbase"] = mbase
    out["vix"] = panel["vix"]
    out["spy_adj"] = panel["spy_adj"]
    out["y3m"] = panel["y3m"]
    out["y10y"] = panel["y10y"]
    return out


if __name__ == "__main__":
    panel = build_panel()
    scores = macro_score(panel)
    ready = scores.dropna(subset=["mbase"])
    print(f"Panel: {len(panel)} rows  {panel.index.min().date()} → {panel.index.max().date()}")
    print(f"Scoring: {len(ready)} rows with mBase  {ready.index.min().date()} → {ready.index.max().date()}")
    print("\nmBase distribution:")
    print(ready["mbase"].value_counts().sort_index().to_string())
    print("\nrecent 5:")
    print(ready[["mbase", "sma_score", "adx_score", "ffr_score", "yield_score", "credit_score"]].tail())
