"""Transfermarkt squad values: the page parser, the name join and the update,
all offline (a made-up page in Transfermarkt's table shape)."""

import json

from elitetracker.normalize.matches import Match
from elitetracker.sources import transfermarkt

PAGE = """<table class="items"><thead><tr><th>Club</th></tr></thead>
<tfoot><tr><td class="rechts">€1.00m</td><td class="rechts">€40.00m</td></tr></tfoot><tbody>
<tr class="odd"><td class="zentriert no-border-rechts"><a title="FK Nordby/Glimt" href="/x/startseite/verein/1/saison_id/2025"></a></td>
<td class="hauptlink no-border-links"><a title="FK Nordby/Glimt" href="/x/startseite/verein/1/saison_id/2025">FK Nordby/Glimt</a></td>
<td class="zentriert">25</td><td class="rechts">€3.17m</td><td class="rechts"><a href="#">€79.18m</a></td></tr>
<tr class="even"><td class="zentriert no-border-rechts"></td>
<td class="hauptlink no-border-links"><a title="Sørby Fotball Elite" href="/y/startseite/verein/2/saison_id/2025">Sørby Fotball Elite</a></td>
<td class="zentriert">30</td><td class="rechts">€932k</td><td class="rechts">€850k</td></tr>
<tr class="odd"><td class="zentriert no-border-rechts"></td>
<td class="hauptlink no-border-links"><a title="HamKam" href="/z/startseite/verein/3/saison_id/2025">HamKam</a></td>
<td class="rechts">€1.20bn</td><td class="rechts">€1.20bn</td></tr>
<tr class="even"><td class="zentriert no-border-rechts"></td>
<td class="hauptlink no-border-links"><a title="Ukjent IL" href="/w/startseite/verein/4/saison_id/2025">Ukjent IL</a></td>
<td class="rechts">€1.00m</td><td class="rechts">€2.00m</td></tr>
</tbody></table>"""


def match(home_id, home, away_id, away):
    return Match(match_id=f"{home_id}{away_id}", date="2026-04-01", time="18:00", home=home, away=away,
                 home_goals=None, away_goals=None, played=False, home_id=home_id, away_id=away_id)


MATCHES = [match("10", "Nordby/Glimt", "20", "Sørby"), match("30", "Hamarkameratene", "20", "Sørby")]


def test_the_parser_reads_each_club_and_its_total():
    assert transfermarkt.parse_values(PAGE) == [
        ("FK Nordby/Glimt", 79.18e6), ("Sørby Fotball Elite", 850e3), ("HamKam", 1.2e9), ("Ukjent IL", 2e6)]


def test_the_join_folds_club_words_aliases_and_a_unique_containment():
    joined, unmatched = transfermarkt.join(transfermarkt.parse_values(PAGE), MATCHES)
    assert {team: entry["name"] for team, entry in joined.items()} == {"10": "Nordby/Glimt", "20": "Sørby", "30": "Hamarkameratene"}
    assert unmatched == ["Ukjent IL"]
    assert transfermarkt.club_key("Aalesunds FK") == transfermarkt.club_key("Aalesund")
    assert transfermarkt.club_key("Sarpsborg 08 FF") == transfermarkt.club_key("Sarpsborg 08")


def test_an_update_writes_the_season_and_keeps_the_others(tmp_path):
    path = tmp_path / "values.json"
    path.write_text(json.dumps({"2025": {"10": {"name": "Nordby/Glimt", "total": 1.0, "league": "eliteserien"}}}))
    asked = []

    def fetch(league, season):
        asked.append((league, season))
        return PAGE

    entries, unmatched = transfermarkt.update_values(
        2026, {"eliteserien": MATCHES[:1], "obosligaen": MATCHES[1:]}, path=path, fetch=fetch, pause=lambda: None)
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert asked == [("eliteserien", 2026), ("obosligaen", 2026)]
    assert stored["2025"]["10"]["total"] == 1.0
    assert stored["2026"]["10"] == {"name": "Nordby/Glimt", "total": 79.18e6, "league": "eliteserien"}
    assert stored["2026"]["30"]["league"] == "obosligaen"
    dry = tmp_path / "dry.json"
    transfermarkt.update_values(2026, {"eliteserien": MATCHES}, path=dry, fetch=fetch, write=False)
    assert not dry.exists()
