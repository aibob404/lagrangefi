"""Analyze HLP (Hyperliquidity Provider) vault historical performance.

HLP is HL's community vault that market-makes, liquidates, and earns platform fees.
Anyone can deposit USDC into HLP and earn/lose based on vault performance.

API: POST /info with {"type":"vaultDetails","vaultAddress":"0xdfc24b077bc1425ad1dea75bcb6f8158e10df303"}
Returns: name, portfolio (accountValueHistory + pnlHistory) at multiple timeframes.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from common import Metrics, metrics, summarize

DATA = Path(__file__).parent / "data"
HLP_ADDRESS = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303"


def fetch_vault(address: str = HLP_ADDRESS) -> dict:
    path = DATA / "hlp_vault.json"
    if path.exists():
        return json.loads(path.read_text())
    r = requests.post("https://api.hyperliquid.xyz/info",
                      json={"type": "vaultDetails", "vaultAddress": address}, timeout=30)
    r.raise_for_status()
    data = r.json()
    path.write_text(json.dumps(data))
    return data


def extract_portfolio(data: dict, horizon: str = "allTime") -> pd.DataFrame:
    """Portfolio entries are [[name, {accountValueHistory, pnlHistory, vlm}]]."""
    for name, body in data.get("portfolio", []):
        if name == horizon:
            avh = body.get("accountValueHistory", [])
            pnl = body.get("pnlHistory", [])
            df = pd.DataFrame(avh, columns=["ts", "accountValue"])
            df["ts"] = df["ts"].astype("int64")
            df["accountValue"] = df["accountValue"].astype(float)
            df["time"] = pd.to_datetime(df["ts"], unit="ms", utc=True).dt.tz_localize(None)
            df = df.set_index("time").drop(columns=["ts"]).sort_index()

            pdf = pd.DataFrame(pnl, columns=["ts", "pnl"])
            pdf["pnl"] = pdf["pnl"].astype(float)
            pdf["time"] = pd.to_datetime(pdf["ts"].astype("int64"), unit="ms", utc=True).dt.tz_localize(None)
            pdf = pdf.set_index("time").drop(columns=["ts"]).sort_index()
            return df.join(pdf, how="outer").ffill()
    return pd.DataFrame()


def main():
    data = fetch_vault()
    print(f"Vault: {data.get('name')}")
    print(f"  Leader: {data.get('leader')}")
    print(f"  Address: {data.get('vaultAddress')}")
    print(f"  Portfolio horizons: {[p[0] for p in data.get('portfolio', [])]}")

    df = extract_portfolio(data, "allTime")
    if df.empty:
        print("No allTime data")
        return
    df = df.resample("D").last().dropna()
    print(f"\nAccount value history: {len(df)} days  {df.index.min().date()} → {df.index.max().date()}")
    print(f"  Start AV: ${df['accountValue'].iloc[0]:,.0f}")
    print(f"  End AV:   ${df['accountValue'].iloc[-1]:,.0f}")

    # HLP vault deposit price = accountValue (approx, modulo new deposits/withdrawals)
    # PnL-based HLP TWR: use pnl series normalized by average value
    # Conservative: treat accountValue as NAV per-share proxy assuming deposits roll in linearly.
    # Actually HLP has an on-chain price-per-share. The API's portfolio graph is approximate.

    # Estimate HLP token price via compound PnL / rolling avg NAV
    pnl = df["pnl"].diff().dropna()
    # Daily return ≈ daily pnl / accountValue at start of day
    rets = (df["pnl"].diff() / df["accountValue"].shift(1)).dropna()
    rets = rets.replace([np.inf, -np.inf], np.nan).fillna(0)
    # clip wild values (deposits/withdrawals cause spikes)
    rets = rets.clip(-0.2, 0.2)
    eq = (1 + rets).cumprod()

    print()
    summarize("HLP vault (daily TWR)", eq)

    # Sub-period: 2024 vs 2025
    for lo, hi, lbl in [
        ("2023-01-01", "2023-12-31", "2023"),
        ("2024-01-01", "2024-12-31", "2024"),
        ("2025-01-01", "2025-12-31", "2025"),
        ("2026-01-01", "2026-12-31", "2026 YTD"),
    ]:
        sub = eq.loc[(eq.index >= lo) & (eq.index <= hi)]
        if len(sub) < 5:
            continue
        sub_eq = sub / sub.iloc[0]
        m = metrics(sub_eq)
        print(f"  {lbl:10s}  CAGR={m.cagr*100:6.2f}%  Sharpe={m.sharpe:4.2f}  MaxDD={m.max_dd*100:6.2f}%  days={len(sub)}")


if __name__ == "__main__":
    main()
