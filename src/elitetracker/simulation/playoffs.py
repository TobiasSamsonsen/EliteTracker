"""The play-offs after the season, played inside every Monte Carlo run.

Three places are settled by knockout ties rather than by the table (NFF's
"kvalifisering", checked against each season's results):

* OBOS-ligaen's 3rd to 6th play single matches for a place in the final.
  From 2019 it is a ladder: 5th v 6th, the winner away at 4th, then away at
  3rd. In 2015-2018 it was 3rd v 6th and 4th v 5th, the winners meeting at the
  higher-placed club's ground.
* The bracket winner meets Eliteserien's 14th over two legs for the place in
  Eliteserien: promotion for the one, relegation for the other.
* OBOS-ligaen's 14th meets a second-tier side over two legs to stay up.

A tie level after 90 minutes (or 180 over two legs) goes to extra time and
penalties. Extra time settles about half of them (30 minutes at Norwegian
scoring rates leave it goalless or level roughly half the time), in the
proportion of the two sides' win odds; the rest are a coin on penalties.

Each match is drawn the way the season's fixtures are (`season._fixtures`):
the blended outcome odds, scaled by the run's strength shocks, and a
scoreline from the goals model for the two-legged ties. A run's clubs keep
the shocks they played the season with, so a side that finished 14th in a
run tends to be the weaker side it was there; the opponent from the other
division comes with its own run's club and shock (`Opponent`).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from elitetracker.model.attack_defence import AttackDefence
from elitetracker.model.elo import EloConfig
from elitetracker.normalize.matches import Match

# The share of ties level at full time that extra time settles; the rest go to
# penalties, a coin.
EXTRA_TIME_DECIDES = 0.5
# The ladder replaced semi-finals in this season's play-off.
LADDER_FROM = 2019


@dataclass(frozen=True)
class Opponent:
    """The club across a two-legged tie, run by run: which of `team_ids` it is
    and that run's strength shock (log scale), from its own division's
    simulation."""

    team_ids: tuple[str, ...]
    club: np.ndarray
    shock: np.ndarray


@dataclass(frozen=True)
class Playoffs:
    """What a division's simulation plays after its table is final.

    `bracket` is the promotion play-off's places, best first; `final`, who
    the bracket winner meets over two legs for promotion (None: the bracket
    is played for its winner only, as the division above needs it).
    `survival_position` must win a two-legged tie against `survival` to stay
    up."""

    bracket: tuple[int, ...] = ()
    ladder: bool = True
    final: Opponent | None = None
    survival_position: int | None = None
    survival: Opponent | None = None


@dataclass
class PlayoffTally:
    """Per club of the division: runs won the bracket, promoted through the
    final, relegated through the survival tie. Plus, for the division above,
    the bracket winner of every run (club index and shock), in run order."""

    bracket_wins: np.ndarray
    promoted: np.ndarray
    relegated: np.ndarray
    winner_club: list[np.ndarray]
    winner_shock: list[np.ndarray]


def _advance_on_draw(win: np.ndarray, loss: np.ndarray) -> np.ndarray:
    """The chance the side with these odds goes through from a level tie."""
    return EXTRA_TIME_DECIDES * win / (win + loss) + (1.0 - EXTRA_TIME_DECIDES) * 0.5


class Knockout:
    """Every pairing the play-offs can produce, prepared once per simulation:
    outcome odds and scoreline tables, as the season's fixtures have them."""

    def __init__(
        self,
        playoffs: Playoffs,
        team_ids: list[str],
        ratings: dict[str, float],
        ad: AttackDefence,
        elo_config: EloConfig,
        on: str,
        blend: bool,
        rng: np.random.Generator,
    ):
        from elitetracker.simulation.season import _fixtures  # season imports this module

        self.playoffs = playoffs
        self.count = len(team_ids)
        self.rng = rng
        extra = []
        for opponent in (playoffs.final, playoffs.survival):
            if opponent is not None:
                extra += [team for team in opponent.team_ids if team not in team_ids and team not in extra]
        self.ids = list(team_ids) + extra
        self.index_of = {team: index for index, team in enumerate(self.ids)}
        # The other division's clubs map into this simulation's club axis.
        self.final_index = self._mapped(playoffs.final)
        self.survival_index = self._mapped(playoffs.survival)

        pairs: set[tuple[int, int]] = set()
        if playoffs.bracket:
            pairs |= {(h, a) for h in range(self.count) for a in range(self.count) if h != a}
        for mapped in (self.final_index, self.survival_index):
            if mapped is not None:
                for other in set(mapped.tolist()):
                    for own in range(self.count):
                        pairs |= {(own, other), (other, own)}
        pairs = sorted(pairs)
        size = len(self.ids)
        self.row_of = np.full((size, size), -1, dtype=np.intp)
        for row, (h, a) in enumerate(pairs):
            self.row_of[h, a] = row
        matches = [
            Match(match_id=f"playoff-{h}-{a}", date=on, time=None, home=self.ids[h], away=self.ids[a],
                  home_goals=None, away_goals=None, played=False, home_id=self.ids[h], away_id=self.ids[a])
            for h, a in pairs
        ]
        self.fixtures = _fixtures(matches, ratings, self.index_of, elo_config, ad, blend) if matches else None

    def _mapped(self, opponent: Opponent | None) -> np.ndarray | None:
        if opponent is None:
            return None
        lookup = np.array([self.index_of[team] for team in opponent.team_ids], dtype=np.intp)
        return lookup[opponent.club]

    def _odds(self, home: np.ndarray, away: np.ndarray, shock: np.ndarray):
        """Win, draw and loss for the home side of each run's pairing, the
        strength shocks applied as on the season's fixtures."""
        row = self.row_of[home, away]
        win, home_or_draw = self.fixtures.home_win[row], self.fixtures.home_or_draw[row]
        runs = np.arange(len(home))
        ratio = np.exp(shock[runs, home] - shock[runs, away])
        weights = np.stack([win * ratio, home_or_draw - win, (1.0 - home_or_draw) / ratio], axis=1)
        weights /= weights.sum(axis=1, keepdims=True)
        return row, weights

    def _single(self, home: np.ndarray, away: np.ndarray, shock: np.ndarray) -> np.ndarray:
        """One match, extra time and penalties if level: who goes through."""
        _, odds = self._odds(home, away, shock)
        through = odds[:, 0] + odds[:, 1] * _advance_on_draw(odds[:, 0], odds[:, 2])
        return np.where(self.rng.random(len(home)) < through, home, away)

    def _leg(self, home: np.ndarray, away: np.ndarray, shock: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """One leg's scoreline (home goals, away goals) and the home side's odds."""
        from elitetracker.simulation.season import SCORELINE_TABLES, TABLE_WIDTH

        row, odds = self._odds(home, away, shock)
        roll = self.rng.random(len(home))
        outcome = (roll >= odds[:, 0]).astype(np.int64) + (roll >= odds[:, 0] + odds[:, 1])
        slot = self.rng.random(len(home)) * TABLE_WIDTH
        column = slot.astype(np.int64)
        table = (row * 3 + outcome) * TABLE_WIDTH
        column = np.where(slot - column < self.fixtures.accept[table + column], column, self.fixtures.alias[table + column])
        cells = SCORELINE_TABLES.reshape(3 * TABLE_WIDTH, 2)[outcome * TABLE_WIDTH + column]
        return cells[:, 0], cells[:, 1], odds

    def _two_legs(self, side: np.ndarray, other: np.ndarray, shock: np.ndarray) -> np.ndarray:
        """Whether `side` wins a home-and-away tie against `other` on aggregate,
        extra time and penalties after the second leg if level."""
        first_home, first_away, odds_home = self._leg(side, other, shock)
        second_home, second_away, odds_away = self._leg(other, side, shock)
        margin = (first_home - first_away) - (second_home - second_away)
        win = (odds_home[:, 0] + odds_away[:, 2]) / 2.0
        loss = (odds_home[:, 2] + odds_away[:, 0]) / 2.0
        level = self.rng.random(len(side)) < _advance_on_draw(win, loss)
        return (margin > 0) | ((margin == 0) & level)

    def _bracket(self, order: np.ndarray, shock: np.ndarray) -> np.ndarray:
        """The bracket's winner (club index) in every run."""
        at = {place: order[:, place - 1] for place in self.playoffs.bracket}
        first, second, third, fourth = self.playoffs.bracket
        if self.playoffs.ladder:
            winner = self._single(at[third], at[fourth], shock)
            winner = self._single(at[second], winner, shock)
            return self._single(at[first], winner, shock)
        upper = self._single(at[first], at[fourth], shock)
        lower = self._single(at[second], at[third], shock)
        # The higher-placed of the two semi-final winners hosts.
        rank = np.empty_like(order)
        rank[np.arange(len(order))[:, None], order] = np.arange(order.shape[1])
        upper_hosts = rank[np.arange(len(order)), upper] < rank[np.arange(len(order)), lower]
        return self._single(np.where(upper_hosts, upper, lower), np.where(upper_hosts, lower, upper), shock)

    def play(self, order: np.ndarray, own_shock: np.ndarray, first_run: int, tally: PlayoffTally) -> None:
        """Play a chunk of runs (`order`: club per finishing place, best first)."""
        runs = len(order)
        rows = slice(first_run, first_run + runs)
        shock = np.zeros((runs, len(self.ids)))
        shock[:, :self.count] = own_shock
        for opponent, mapped in ((self.playoffs.final, self.final_index), (self.playoffs.survival, self.survival_index)):
            if opponent is not None:
                shock[np.arange(runs), mapped[rows]] = opponent.shock[rows]
        if self.playoffs.bracket:
            winner = self._bracket(order, shock)
            tally.bracket_wins += np.bincount(winner, minlength=self.count)
            tally.winner_club.append(winner)
            tally.winner_shock.append(own_shock[np.arange(runs), winner])
            if self.playoffs.final is not None:
                promoted = self._two_legs(winner, self.final_index[rows], shock)
                tally.promoted += np.bincount(winner[promoted], minlength=self.count)
        if self.playoffs.survival is not None:
            club = order[:, self.playoffs.survival_position - 1]
            stayed = self._two_legs(club, self.survival_index[rows], shock)
            tally.relegated += np.bincount(club[~stayed], minlength=self.count)
