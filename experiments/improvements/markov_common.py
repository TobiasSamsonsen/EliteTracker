"""Shared pieces of the shock / Markov-chain study (November 2026): team-match
residual rows built from the shipped blend's pre-match odds, and cluster-robust
tests. Local files only; no src edits.

Every residual is signed so that positive = the club did better than the model
expected before kickoff (so a positive next-match mean after a state = the model
under-reacts to that state, negative = it over-reacts).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import harness as H  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402


def poisson_pmf(lam, n=13):
    k = np.arange(n)
    from math import lgamma
    lam = max(lam, 1e-9)
    return np.exp(-lam + k * math.log(lam) - np.array([lgamma(i + 1) for i in k]))


def xg_points(xf, xa):
    """Expected points (3 win / 1 draw) of the side with xG xf against xa, Poisson independent."""
    pf, pa = poisson_pmf(xf), poisson_pmf(xa)
    pf, pa = pf / pf.sum(), pa / pa.sum()
    cum = np.cumsum(pa)
    win = float((pf[1:] * cum[:-1]).sum())
    draw = float((pf * pa).sum())
    return 3 * win + draw


def build(mix=None, ad=None, cache=None):
    """Long table, two rows per played match (home, away), kickoff order.
    Columns are numpy arrays in a dict."""
    if cache and Path(cache).exists():
        z = np.load(cache, allow_pickle=True)
        return {k: z[k] for k in z.files}
    if mix is None:
        elo, ad, mix = H.shipped()
    n = len(H.PLAYED)
    rows = {k: [] for k in ("mi", "team", "side", "season", "league", "pts", "xpts", "var", "gf", "ga", "lf", "la",
                            "xf", "xa", "xgp", "hasxg", "pw", "pd", "pl")}
    for i, (m, lg, season) in enumerate(H.PLAYED):
        home, away = team_ids(m)
        xg = H.SHOTS.get(m.match_id)
        has = bool(xg and len(xg) >= 2)
        ph, pd_, pa_ = mix[i]
        for side, (t, gf, ga, lf, la, pw, pdd, pl) in enumerate((
            (home, m.home_goals, m.away_goals, ad.lam[i], ad.mu[i], ph, pd_, pa_),
            (away, m.away_goals, m.home_goals, ad.mu[i], ad.lam[i], pa_, pd_, ph),
        )):
            pts = 3.0 if gf > ga else (1.0 if gf == ga else 0.0)
            xp = 3 * pw + pdd
            v = 9 * pw + pdd - xp * xp
            xf_, xa_ = (xg[0], xg[1]) if has and side == 0 else ((xg[1], xg[0]) if has else (np.nan, np.nan))
            rows["mi"].append(i); rows["team"].append(t); rows["side"].append(side); rows["season"].append(season)
            rows["league"].append(lg); rows["pts"].append(pts); rows["xpts"].append(xp); rows["var"].append(v)
            rows["gf"].append(gf); rows["ga"].append(ga); rows["lf"].append(lf); rows["la"].append(la)
            rows["xf"].append(xf_); rows["xa"].append(xa_)
            rows["xgp"].append(xg_points(xf_, xa_) if has else np.nan)
            rows["hasxg"].append(has); rows["pw"].append(pw); rows["pd"].append(pdd); rows["pl"].append(pl)
    out = {k: np.array(v) for k, v in rows.items()}
    # residuals, positive = better than expected
    out["pts_res"] = out["pts"] - out["xpts"]
    out["z_pts"] = out["pts_res"] / np.sqrt(out["var"])
    out["gd_res"] = (out["gf"] - out["ga"]) - (out["lf"] - out["la"])
    out["gf_res"] = out["gf"] - out["lf"]
    out["ga_res"] = out["la"] - out["ga"]
    out["xg_res"] = out["xf"] - out["lf"]
    out["xga_res"] = out["la"] - out["xa"]
    out["xgd_res"] = out["xg_res"] + out["xga_res"]
    out["xgpts_res"] = out["xgp"] - out["xpts"]
    out["luck_res"] = out["pts"] - out["xgp"]          # result better than the chances warranted
    out["fin_res"] = out["gf"] - out["xf"]              # finishing: goals above xG
    out["keep_res"] = out["xa"] - out["ga"]             # keeping: xGA above goals conceded
    if cache:
        np.savez(cache, **out)
    return out


def group_prev(d, lag=1):
    """Index of the same club's row `lag` matches earlier in the same season, else -1."""
    key = {}
    prev = np.full(len(d["mi"]), -1)
    seq = {}
    order = np.argsort(d["mi"], kind="stable")
    for r in order:
        g = (d["team"][r], d["season"][r])
        lst = seq.setdefault(g, [])
        if len(lst) >= lag:
            prev[r] = lst[-lag]
        lst.append(r)
    return prev


def cluster_ids(d):
    ids = {}
    return np.array([ids.setdefault((t, s), len(ids)) for t, s in zip(d["team"], d["season"])])


def cluster_mean(y, g):
    """mean and cluster-robust standard error (clusters g)."""
    n = len(y)
    mu = y.mean()
    e = y - mu
    sums = np.bincount(g, weights=e)
    return mu, math.sqrt((sums ** 2).sum()) / n


def cluster_ols(X, y, g):
    """OLS with cluster-robust (CR0) standard errors. Returns beta, se."""
    X = np.asarray(X, float)
    XtX_inv = np.linalg.pinv(X.T @ X)
    beta = XtX_inv @ X.T @ y
    e = y - X @ beta
    k = X.shape[1]
    meat = np.zeros((k, k))
    ng = g.max() + 1
    S = np.zeros((ng, k))
    np.add.at(S, g, X * e[:, None])
    meat = S.T @ S
    cov = XtX_inv @ meat @ XtX_inv
    return beta, np.sqrt(np.diag(cov))


# --- tilt engine (shared by the match-level and season-level sweeps) ---
U = np.array([0.5, 0.0, -0.5])


def fit(X, lp, y, ridge, iters=25):
    """Max-likelihood beta for p' ~ p exp(U psi), psi = X beta (Newton, ridge)."""
    beta = np.zeros(X.shape[1])
    for _ in range(iters):
        psi = X @ beta
        lg = lp + psi[:, None] * U
        lg -= lg.max(1, keepdims=True)
        pr = np.exp(lg); pr /= pr.sum(1, keepdims=True)
        Eu = pr @ U
        g = X.T @ (U[y] - Eu) - ridge * beta
        var = pr @ (U ** 2) - Eu ** 2
        Hs = X.T @ (X * var[:, None]) + ridge * np.eye(X.shape[1])
        step = np.linalg.solve(Hs, g)
        beta += step
        if np.abs(step).max() < 1e-7:
            break
    return beta


def tilt(X, lp, beta):
    psi = X @ beta
    lg = lp + psi[:, None] * U
    lg -= lg.max(1, keepdims=True)
    pr = np.exp(lg)
    return pr / pr.sum(1, keepdims=True)
