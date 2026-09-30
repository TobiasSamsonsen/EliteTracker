# Mobile audit — baseline

- generated: 2026-09-30 18:48:22
- base: http://127.0.0.1:8123
- run seconds: 88.2

## CSS static checks (styles.css occurrences)

| check | count |
|---|---|
| uses_100vh | 0 |
| uses_100dvh | 0 |
| safe_area_env | 4 |
| tap_highlight | 1 |
| prefers_reduced_motion | 4 |
| prefers_color_scheme | 0 |
| overscroll_behavior | 1 |
| touch_action | 0 |
| scroll_padding | 2 |
| media_760 | 18 |

## Per-viewport summary

| viewport | views loaded | console errs | doc overflow | small tap targets | inputs <16px | clipped text | overlaps |
|---|---|---|---|---|---|---|---|
| 320x568 | 7/7 | 0 | no | 7 | 10 | 7 | 30 |
| 375x667 | 7/7 | 0 | no | 17 | 10 | 0 | 22 |
| 390x844 | 7/7 | 0 | no | 25 | 10 | 0 | 14 |
| 412x915 | 7/7 | 0 | no | 29 | 10 | 0 | 12 |
| 844x390-landscape | 7/7 | 0 | no | 7 | 10 | 0 | 14 |
| 768x1024-tablet | 7/7 | 0 | no | 77 | 10 | 0 | 10 |
| 1440x900-desktop | 7/7 | 0 | no | 143 | 10 | 0 | 0 |

## P0-A: More menu

**320x568** — open: {'hit': True, 'at': [288, 542], 'under_pointer': 'button#more-button.mobilebar__item', 'sheet_open_after_tap': True, 'aria_expanded': 'true'}
- ladder: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- compare: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- model: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- outside tap closes: {'sheet_closed': True, 'errors': []}
**375x667** — open: {'hit': True, 'at': [338, 641], 'under_pointer': 'button#more-button.mobilebar__item', 'sheet_open_after_tap': True, 'aria_expanded': 'true'}
- ladder: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- compare: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- model: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- outside tap closes: {'sheet_closed': True, 'errors': []}
**390x844** — open: {'hit': True, 'at': [351, 818], 'under_pointer': 'button#more-button.mobilebar__item', 'sheet_open_after_tap': True, 'aria_expanded': 'true'}
- ladder: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- compare: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- model: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- outside tap closes: {'sheet_closed': True, 'errors': []}
**412x915** — open: {'hit': True, 'at': [371, 889], 'under_pointer': 'button#more-button.mobilebar__item', 'sheet_open_after_tap': True, 'aria_expanded': 'true'}
- ladder: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- compare: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- model: switched=NO sheet_closed=True url_view=grid errors=0 under_pointer=button.sheet__item
- outside tap closes: {'sheet_closed': True, 'errors': []}

## P0-B: swipe navigation

- **320x568**: view1=grid cls=0/0 maxDocDelta=0px maxPanelDelta=0px scroll {'before': 909, 'after_swipe1': 909, 'after_swipe2': 909, 'restored': True}
  - console: pageerror: switchView is not defined
- **375x667**: view1=grid cls=0/0 maxDocDelta=0px maxPanelDelta=0px scroll {'before': 762, 'after_swipe1': 762, 'after_swipe2': 762, 'restored': True}
  - console: pageerror: switchView is not defined
- **390x844**: view1=grid cls=0/0 maxDocDelta=0px maxPanelDelta=0px scroll {'before': 565, 'after_swipe1': 565, 'after_swipe2': 565, 'restored': True}
  - console: pageerror: switchView is not defined
- **412x915**: view1=grid cls=0/0 maxDocDelta=0px maxPanelDelta=0px scroll {'before': 494, 'after_swipe1': 494, 'after_swipe2': 494, 'restored': True}
  - console: pageerror: switchView is not defined

## Content-area swipe (pull-to-refresh interference)

- **320x568** horizontal: cls_delta=0 scroll_y=0 fetches=0 ptr={'cls': 'ptr-indicator', 'tf': 'matrix(1, 0, 0, 1, 0, -60)', 'op': '0'} maxDocDelta=0px errors=0
- **320x568** diagonal: cls_delta=0 scroll_y=0 fetches=0 ptr={'cls': 'ptr-indicator', 'tf': 'matrix(1, 0, 0, 1, 0, -60)', 'op': '0'} maxDocDelta=0px errors=0
- **375x667** horizontal: cls_delta=0 scroll_y=0 fetches=0 ptr={'cls': 'ptr-indicator', 'tf': 'matrix(1, 0, 0, 1, 0, -60)', 'op': '0'} maxDocDelta=0px errors=0
- **375x667** diagonal: cls_delta=0 scroll_y=0 fetches=0 ptr={'cls': 'ptr-indicator', 'tf': 'matrix(1, 0, 0, 1, 0, -60)', 'op': '0'} maxDocDelta=0px errors=0
- **390x844** horizontal: cls_delta=0 scroll_y=0 fetches=0 ptr={'cls': 'ptr-indicator', 'tf': 'matrix(1, 0, 0, 1, 0, -60)', 'op': '0'} maxDocDelta=0px errors=0
- **390x844** diagonal: cls_delta=0 scroll_y=0 fetches=0 ptr={'cls': 'ptr-indicator', 'tf': 'matrix(1, 0, 0, 1, 0, -60)', 'op': '0'} maxDocDelta=0px errors=0
- **412x915** horizontal: cls_delta=0 scroll_y=0 fetches=0 ptr={'cls': 'ptr-indicator', 'tf': 'matrix(1, 0, 0, 1, 0, -60)', 'op': '0'} maxDocDelta=0px errors=0
- **412x915** diagonal: cls_delta=0 scroll_y=0 fetches=0 ptr={'cls': 'ptr-indicator', 'tf': 'matrix(1, 0, 0, 1, 0, -60)', 'op': '0'} maxDocDelta=0px errors=0

## Tab-switch scroll jump (tap path)

- **320x568**: scroll 909 → 0 (jump 909px), doc height delta 827px, cls +0, errors=1
- **375x667**: scroll 762 → 0 (jump 762px), doc height delta 783px, cls +0, errors=1
- **390x844**: scroll 565 → 0 (jump 565px), doc height delta 783px, cls +0, errors=1
- **412x915**: scroll 494 → 0 (jump 494px), doc height delta 783px, cls +0, errors=1

## Tab taps and team focus

- 320x568: tab taps ok=4/4 | team opened=True
- 375x667: tab taps ok=4/4 | team opened=True
- 390x844: tab taps ok=4/4 | team opened=True
- 412x915: tab taps ok=4/4 | team opened=True
- 844x390-landscape: tab taps ok=4/4 | team opened=True
- 768x1024-tablet: tab taps ok=4/4 | team opened=True
- 1440x900-desktop: tab taps ok=4/4 | team opened=True
