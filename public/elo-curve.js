/* The model's price curve, shared by the model page (model.html, model.js) and
   the Predict game (the slider's odds): model/probabilities.py in JavaScript.
   tests/frontend.test.js pins it to the Python model's numbers. A classic
   script: load it before model.js (or predict.js); the node tests require it. */

function expectedScore(gap) {
  return 1 / (1 + 10 ** (-gap / 400));
}

/* model/probabilities.py: home win, draw, away win at an effective gap
   (home advantage included). drawFactor scales the draw mass (the Predict
   slider's "draw tendency"; 1 is the model's own shape). */
function eloOdds(gap, model, drawFactor = 1) {
  const expected = expectedScore(gap);
  const draw = Math.min(model.draw_base * Math.exp(-((gap / model.draw_scale) ** 2)) * drawFactor,
    2 * Math.min(expected, 1 - expected));
  return [expected - draw / 2, draw, 1 - expected - draw / 2];
}

if (typeof module !== 'undefined') module.exports = { expectedScore, eloOdds };
