"""Generate equity-curve plots for the final report."""
from __future__ import annotations

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from common import TRADING_DAYS, metrics
from final import build_long_panel, pos_smart_entry_exit
from refinements import add_vix_term, pos_buffered_smart, pos_dual_sma_confirm


def equity_of(df, pos, start="1994-01-01"):
    pos_s = pos.shift(1).fillna(0)
    cash_r = df["cash_ret"]
    r = (pos_s * df["spy_ret"] - (pos_s-1).clip(lower=0)*cash_r - (pos_s>0)*0.009/TRADING_DAYS
         + (1-pos_s).clip(lower=0)*cash_r)
    r = r - pos_s.diff().abs().fillna(0) * 2.0 / 10000.0
    r = r.loc[r.index >= start]
    return (1 + r.fillna(0)).cumprod()


def main():
    df = add_vix_term(build_long_panel())
    start = "1994-01-01"

    # Compute curves
    spy_eq = (1 + df["spy_ret"].loc[start:]).cumprod()
    strats = {
        "SPY buy-and-hold":            spy_eq,
        "2x smart SMA200/100":         equity_of(df, pos_smart_entry_exit(df, 2.0, 200, 100), start),
        "2x smart hold=5d":            equity_of(df, pos_buffered_smart(df, 2.0, 200, 100, 0.0, 5), start),
        "2x dual-SMA confirm":         equity_of(df, pos_dual_sma_confirm(df, 2.0), start),
        "3x smart hold=5d":            equity_of(df, pos_buffered_smart(df, 3.0, 200, 100, 0.0, 5), start),
    }

    # Plot 1: equity curves (log scale)
    fig, axes = plt.subplots(2, 1, figsize=(12, 9), sharex=True,
                             gridspec_kw={"height_ratios": [3, 1]})
    ax = axes[0]
    colors = ["#222222", "#1f77b4", "#2ca02c", "#9467bd", "#d62728"]
    for (name, eq), c in zip(strats.items(), colors):
        lw = 2.5 if name == "SPY buy-and-hold" else 1.8
        ax.plot(eq.index, eq, label=name, color=c, linewidth=lw)
    ax.set_yscale("log")
    ax.set_ylabel("Growth of $1 (log scale)")
    ax.set_title("SPY vs trend-filtered leveraged strategies (1994-2026)")
    ax.grid(alpha=0.3, which="both")
    ax.legend(loc="upper left", framealpha=0.9)

    # Plot 2: drawdowns
    ax2 = axes[1]
    for (name, eq), c in zip(strats.items(), colors):
        dd = eq / eq.cummax() - 1
        lw = 2.5 if name == "SPY buy-and-hold" else 1.3
        ax2.fill_between(dd.index, dd * 100, 0, alpha=0.15, color=c) if name == "SPY buy-and-hold" else None
        ax2.plot(dd.index, dd * 100, label=name, color=c, linewidth=lw)
    ax2.set_ylabel("Drawdown %")
    ax2.set_xlabel("Date")
    ax2.grid(alpha=0.3)
    ax2.axhline(0, color="black", linewidth=0.5)

    plt.tight_layout()
    fig.savefig("/home/claude/workspace/lagrangefi/research-py/equity_curves.png", dpi=110, bbox_inches="tight")
    print("Saved equity_curves.png")

    # Plot 2: yearly returns bar chart — simple
    yearly = {}
    for name, eq in strats.items():
        y = eq.resample("YE").last().pct_change().dropna()
        yearly[name] = y
    yearly_df = pd.DataFrame(yearly)

    fig2, ax = plt.subplots(figsize=(14, 5))
    yearly_df.plot.bar(ax=ax, width=0.8)
    ax.set_title("Yearly returns by strategy (1994-2025)")
    ax.set_ylabel("Annual return")
    ax.axhline(0, color="black", linewidth=0.6)
    ax.set_xticklabels([str(d.year) for d in yearly_df.index], rotation=60, ha="right")
    ax.grid(alpha=0.3, axis="y")
    ax.legend(framealpha=0.9, ncol=3, fontsize=9, loc="upper left")
    plt.tight_layout()
    fig2.savefig("/home/claude/workspace/lagrangefi/research-py/yearly_returns.png", dpi=110, bbox_inches="tight")
    print("Saved yearly_returns.png")


if __name__ == "__main__":
    main()
