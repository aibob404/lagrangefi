"""Shared utilities: data loading, indicators, metrics."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).parent / "data"
DAYS_PER_YEAR = 365  # crypto: 365 calendar days
HOURS_PER_YEAR = 365 * 24


def load_candles(coin: str, interval: str = "1d") -> pd.DataFrame:
    path = DATA / f"hl_{coin}_{interval}.csv"
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    df.index = pd.to_datetime(df.index, format="ISO8601", utc=True).tz_localize(None)
    df.index.name = "time"
    return df.sort_index()


def load_funding(coin: str) -> pd.DataFrame:
    path = DATA / f"hl_{coin}_funding.csv"
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    df.index = pd.to_datetime(df.index, format="ISO8601", utc=True).tz_localize(None)
    df.index.name = "time"
    return df.sort_index()


# ---------- indicators ----------

def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def realized_vol(returns: pd.Series, n: int = 30) -> pd.Series:
    """Annualized realized volatility (daily returns → annual)."""
    return returns.rolling(n, min_periods=n).std() * np.sqrt(DAYS_PER_YEAR)


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
            f"{name:38s}  CAGR={self.cagr*100:7.2f}%  "
            f"TR={self.total_return*100:8.1f}%  "
            f"Sharpe={self.sharpe:4.2f}  "
            f"MaxDD={self.max_dd*100:6.2f}%  "
            f"Calmar={self.calmar:4.2f}  "
            f"TIM={self.time_in_mkt*100:5.1f}%  "
            f"Sw={self.num_switches:3d}"
        )


def metrics(equity: pd.Series) -> Metrics:
    eq = equity.dropna()
    if len(eq) < 2:
        return Metrics(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    rets = eq.pct_change().dropna()
    years = (eq.index[-1] - eq.index[0]).days / 365.25
    total = float(eq.iloc[-1] / eq.iloc[0] - 1)
    cagr = (1 + total) ** (1 / max(years, 1e-9)) - 1 if years > 0 else 0.0
    # For crypto daily bars, annualize by sqrt(365)
    vol = float(rets.std() * np.sqrt(DAYS_PER_YEAR))
    sharpe = float(rets.mean() / rets.std() * np.sqrt(DAYS_PER_YEAR)) if rets.std() > 0 else 0.0
    downside = rets[rets < 0]
    sortino = float(rets.mean() / downside.std() * np.sqrt(DAYS_PER_YEAR)) if len(downside) > 1 and downside.std() > 0 else 0.0
    peak = eq.cummax()
    dd = (eq - peak) / peak
    max_dd = float(dd.min())
    calmar = cagr / abs(max_dd) if max_dd < 0 else 0.0
    return Metrics(cagr, total, sharpe, sortino, max_dd, calmar, vol, 1.0, 0, years)


def summarize(name: str, eq: pd.Series, pos: pd.Series | None = None,
              switches: int | None = None) -> Metrics:
    m = metrics(eq)
    tim = float(((pos.shift(1).fillna(0).abs()) > 0).loc[eq.index].mean()) if pos is not None else 1.0
    sw = switches if switches is not None else (
        int((pos.shift(1).fillna(0).diff().abs() > 0.001).loc[eq.index].sum()) if pos is not None else 0
    )
    m = Metrics(m.cagr, m.total_return, m.sharpe, m.sortino, m.max_dd, m.calmar, m.vol, tim, sw, m.years)
    print(m.pretty(name))
    return m
