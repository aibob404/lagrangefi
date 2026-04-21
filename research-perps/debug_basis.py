"""Debug: why does cumulative gross = +18% but CAGR = -6%?"""
from __future__ import annotations

import numpy as np
import pandas as pd

from funding_harvest_v2 import harvest_real


def main():
    df, eq = harvest_real("BTC")
    print(f"BTC: {len(df)} days  {df.index.min()} → {df.index.max()}")
    print(f"  First spot: ${df['spot'].iloc[0]:.2f}   First perp: ${df['perp'].iloc[0]:.2f}   diff {df['perp'].iloc[0]-df['spot'].iloc[0]:+.2f}")
    print(f"  Last  spot: ${df['spot'].iloc[-1]:.2f}   Last  perp: ${df['perp'].iloc[-1]:.2f}   diff {df['perp'].iloc[-1]-df['spot'].iloc[-1]:+.2f}")
    print(f"  Spot TR: {df['spot'].iloc[-1]/df['spot'].iloc[0]-1:+.2%}")
    print(f"  Perp TR: {df['perp'].iloc[-1]/df['perp'].iloc[0]-1:+.2%}")
    print()
    print(f"  Sum of funding_pnl: {df['funding_pnl'].sum():+.4f}")
    print(f"  Sum of delta_pnl (spot_ret - perp_ret): {df['delta_pnl'].sum():+.4f}")
    print(f"  Sum of gross: {df['gross'].sum():+.4f}")
    print(f"  Final equity: {eq.iloc[-1]:.4f}  (CAGR = {(eq.iloc[-1]**(365/(eq.index[-1]-eq.index[0]).days)-1)*100:.2f}%)")
    print()
    # vol analysis
    print(f"  Daily delta_pnl std: {df['delta_pnl'].std():.4f}  = {df['delta_pnl'].std()*np.sqrt(365)*100:.2f}% annualised")
    print(f"  Max daily delta_pnl: {df['delta_pnl'].max():+.4f}")
    print(f"  Min daily delta_pnl: {df['delta_pnl'].min():+.4f}")
    print(f"  Largest 10 |delta_pnl| days:")
    big = df['delta_pnl'].abs().nlargest(10)
    print(df.loc[big.index, ['spot', 'perp', 'delta_pnl']].to_string())
    print()
    # total PnL in absolute dollars on $1 spot:
    # If we buy 1 spot at spot_0 and short 1 perp at perp_0:
    #   final PnL = (spot_f - spot_0) - (perp_f - perp_0) + total_funding_paid_to_us_as_short
    spot_abs = df['spot'].iloc[-1] - df['spot'].iloc[0]
    perp_abs = df['perp'].iloc[-1] - df['perp'].iloc[0]
    print(f"  Absolute basis change: spot_chg={spot_abs:+.2f}  perp_chg={perp_abs:+.2f}  basis_change={spot_abs-perp_abs:+.4f}")
    # as fraction of initial capital (= spot_0)
    basis_pct = (spot_abs - perp_abs) / df['spot'].iloc[0]
    print(f"  Basis change / spot_0: {basis_pct:+.4%}")


if __name__ == "__main__":
    main()
