"""Predict: the prediction game that sharpens the odds (docs/predict.md).

Pure logic lives here (curve, scoring, tables, streaks, boards, nicknames,
calendar); the network is only in sources/firestore.py and the job that wires
them together is elitetracker.predict_sync.
"""
