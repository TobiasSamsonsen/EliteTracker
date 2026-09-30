# Mobile audit — after

- generated: 2026-09-30 19:52:29
- base: http://127.0.0.1:8123
- run seconds: 90.0

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

| viewport | views loaded | console errs | doc overflow | small tap targets | inputs <16px | clipped text | covered targets |
|---|---|---|---|---|---|---|---|
| 320x568 | 7/7 | 0 | no | 0 | 0 | 0 | 0 |
| 375x667 | 7/7 | 0 | no | 0 | 0 | 0 | 0 |
| 390x844 | 7/7 | 0 | no | 0 | 0 | 0 | 0 |
| 412x915 | 7/7 | 0 | no | 0 | 0 | 0 | 0 |
| 844x390-landscape | 7/7 | 0 | no | 0 | 3 | 0 | 0 |
| 768x1024-tablet | 7/7 | 0 | no | 0 | 3 | 0 | 0 |
| 1440x900-desktop | 7/7 | 0 | no | 179 | 3 | 0 | 0 |

## P0-A: More menu

**320x568** — open: {'hit': True, 'at': [288, 542], 'under_pointer': 'button#more-button.mobilebar__item', 'sheet_open_after_tap': True, 'aria_expanded': 'true'}
- ladder: switched=YES sheet_closed=True url_view=ladder errors=0 under_pointer=button.sheet__item
- compare: switched=YES sheet_closed=True url_view=compare errors=0 under_pointer=button.sheet__item
- model: switched=YES sheet_closed=True url_view=model errors=0 under_pointer=button.sheet__item
- outside tap closes: {'sheet_closed': True, 'errors': []}
**375x667** — open: {'hit': True, 'at': [338, 641], 'under_pointer': 'button#more-button.mobilebar__item', 'sheet_open_after_tap': True, 'aria_expanded': 'true'}
- ladder: switched=YES sheet_closed=True url_view=ladder errors=0 under_pointer=button.sheet__item
- compare: switched=YES sheet_closed=True url_view=compare errors=0 under_pointer=button.sheet__item
- model: switched=YES sheet_closed=True url_view=model errors=0 under_pointer=button.sheet__item
- outside tap closes: {'sheet_closed': True, 'errors': []}
**390x844** — open: {'hit': True, 'at': [351, 818], 'under_pointer': 'button#more-button.mobilebar__item', 'sheet_open_after_tap': True, 'aria_expanded': 'true'}
- ladder: switched=YES sheet_closed=True url_view=ladder errors=0 under_pointer=button.sheet__item
- compare: switched=YES sheet_closed=True url_view=compare errors=0 under_pointer=button.sheet__item
- model: switched=YES sheet_closed=True url_view=model errors=0 under_pointer=button.sheet__item
- outside tap closes: {'sheet_closed': True, 'errors': []}
**412x915** — open: {'hit': True, 'at': [371, 889], 'under_pointer': 'button#more-button.mobilebar__item', 'sheet_open_after_tap': True, 'aria_expanded': 'true'}
- ladder: switched=YES sheet_closed=True url_view=ladder errors=0 under_pointer=button.sheet__item
- compare: switched=YES sheet_closed=True url_view=compare errors=0 under_pointer=button.sheet__item
- model: switched=YES sheet_closed=True url_view=model errors=0 under_pointer=button.sheet__item
- outside tap closes: {'sheet_closed': True, 'errors': []}

## P0-B: swipe navigation

- **320x568**: view1=played cls=0/0 maxDocDelta=0px maxPanelDelta=0px scroll {'before': 1607, 'after_swipe1': 0, 'after_swipe2': 0, 'restored': False}
- **375x667**: view1=played cls=0/0 maxDocDelta=0px maxPanelDelta=0px scroll {'before': 1460, 'after_swipe1': 0, 'after_swipe2': 0, 'restored': False}
- **390x844**: view1=played cls=0/0 maxDocDelta=0px maxPanelDelta=0px scroll {'before': 1263, 'after_swipe1': 0, 'after_swipe2': 0, 'restored': False}
- **412x915**: view1=played cls=0/0 maxDocDelta=0px maxPanelDelta=0px scroll {'before': 1192, 'after_swipe1': 0, 'after_swipe2': 0, 'restored': False}

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

- **320x568**: scroll 1607 → 0 (jump 1607px), doc height delta 129px, cls +0, errors=0
- **375x667**: scroll 1460 → 0 (jump 1460px), doc height delta 85px, cls +0, errors=0
- **390x844**: scroll 1263 → 0 (jump 1263px), doc height delta 85px, cls +0, errors=0
- **412x915**: scroll 1192 → 0 (jump 1192px), doc height delta 85px, cls +0, errors=0

## Tab taps and team focus

- 320x568: tab taps ok=4/4 | team opened=True
- 375x667: tab taps ok=4/4 | team opened=True
- 390x844: tab taps ok=4/4 | team opened=True
- 412x915: tab taps ok=4/4 | team opened=True
- 844x390-landscape: tab taps ok=4/4 | team opened=True
- 768x1024-tablet: tab taps ok=4/4 | team opened=True
- 1440x900-desktop: tab taps ok=4/4 | team opened=True
