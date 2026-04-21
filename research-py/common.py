"""Shared utilities: data loading, indicators, backtest metrics."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).parent / "data"
TRADING_DAYS = 252


def load(name: str) -> pd.DataFrame:
    """Load a cached series. Returns DataFrame indexed by date with OHLCV + Adj Close."""
    df = pd.read_csv(DATA / f"{name}.csv", index_col=0, parse_dates=True)
    df.index = pd.to_datetime(df.index, utc=True).tz_localize(None).normalize()
    df.index.name = "date"
    return df.sort_index()


def load_close(name: str, col: str = "Adj Close") -> pd.Series:
    df = load(name)
    if col not in df.columns:
        col = "Close"
    return df[col].astype(float).rename(name)


# ---------- indicators ----------

def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    delta = s.diff()
    up = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def adx(high: pd.Series, low: pd.Series, close: pd.Series, n: int = 14) -> pd.Series:
    """Wilder ADX. Returns the ADX line only."""
    up_move = high.diff()
    dn_move = -low.diff()
    plus_dm = np.where((up_move > dn_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((dn_move > up_move) & (dn_move > 0), dn_move, 0.0)
    tr1 = high - low
    tr2 = (high - close.shift()).abs()
    tr3 = (low - close.shift()).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)

    atr = tr.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    plus_di = 100 * pd.Series(plus_dm, index=high.index).ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / atr
    minus_di = 100 * pd.Series(minus_dm, index=high.index).ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / atr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False, min_periods=n).mean().rename("adx")


def linreg_slope(s: pd.Series) -> float:
    """Slope of linear regression fit to the series (over its own integer index)."""
    y = s.dropna().to_numpy()
    if len(y) < 2:
        return float("nan")
    x = np.arange(len(y), dtype=float)
    a, b = np.polyfit(x, y, 1)
    return float(a)


# ---------- metrics ----------

@dataclass
class Metrics:
    cagr: float
    total_return: float
    sharpe: float
    sortino: float
    max_dd: float
    calmar: float
    vol: float
    time_in_mkt: float
    num_switches: int
    years: float

    def pretty(self, name: str = "") -> str:
        return (
            f"{name:30s}  CAGR={self.cagr*100:6.2f}%  "
            f"TR={self.total_return*100:8.1f}%  "
            f"Sharpe={self.sharpe:4.2f}  "
            f"MaxDD={self.max_dd*100:6.2f}%  "
            f"Calmar={self.calmar:4.2f}  "
            f"TimeInMkt={self.time_in_mkt*100:5.1f}%  "
            f"Switches={self.num_switches:3d}"
        )


def metrics(equity: pd.Series, weights: pd.Series | None = None,
            switches: int | None = None) -> Metrics:
    """Compute performance metrics from an equity curve."""
    equity = equity.dropna()
    if len(equity) < 2:
        return Metrics(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)

    rets = equity.pct_change().dropna()
    years = (equity.index[-1] - equity.index[0]).days / 365.25
    total_return = float(equity.iloc[-1] / equity.iloc[0] - 1)
    cagr = (1 + total_return) ** (1 / max(years, 1e-9)) - 1 if years > 0 else 0.0

    vol = float(rets.std() * np.sqrt(TRADING_DAYS))
    sharpe = float(rets.mean() / rets.std() * np.sqrt(TRADING_DAYS)) if rets.std() > 0 else 0.0

    downside = rets[rets < 0]
    sortino = (rets.mean() / downside.std() * np.sqrt(TRADING_DAYS)) if len(downside) > 1 and downside.std() > 0 else 0.0

    peak = equity.cummax()
    dd = (equity - peak) / peak
    max_dd = float(dd.min())

    calmar = cagr / abs(max_dd) if max_dd < 0 else 0.0

    if weights is not None:
        tim = float((weights.abs().sum(axis=1) if isinstance(weights, pd.DataFrame) else weights).gt(0).mean())
    else:
        tim = 1.0

    return Metrics(cagr, total_return, sharpe, sortino, max_dd, calmar, vol, tim,
                   switches if switches is not None else 0, years)


def simulate(returns_by_ticker: pd.DataFrame, weights: pd.DataFrame,
             cost_bps: float = 1.0) -> tuple[pd.Series, int]:
    """Given next-day returns and target weights (same dates), simulate equity curve.
    weights at date t are applied to returns from t to t+1.
    cost_bps: one-way transaction cost in basis points per unit turnover.
    """
    w = weights.shift(1).fillna(0.0)  # trade at close, earn return next day
    gross = (w * returns_by_ticker).sum(axis=1)
    turnover = (w - w.shift(1)).abs().sum(axis=1).fillna(0)
    costs = turnover * cost_bps / 10000.0
    net = gross - costs
    equity = (1 + net).cumprod()
    switches = int(((w.diff().abs().sum(axis=1) > 0.001)).sum())
    return equity, switches
