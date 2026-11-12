"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Result = require("../main/util/max-out-result.js");

function partsAt(count) {
  return [
    { sheet: true, quantity: 1 },
    { sheet: false, quantity: count },
    { sheet: false, quantity: count },
    { sheet: false, quantity: count },
  ];
}

function nestFor(count, utilisation, overlap) {
  const spots = [];
  for (let i = 0; i < count * 3; i++) {
    const col = i % 11;
    const row = Math.floor(i / 11);
    spots.push({
      id: i,
      source: (i % 3) + 1,
      x: col * 20,
      y: row * 20,
      rotation: 0,
      width: 10,
      height: 10,
    });
  }
  if (overlap) {
    spots.push({
      id: 0,
      source: 1,
      x: 0,
      y: 0,
      rotation: 0,
      width: 10,
      height: 10,
    });
  }
  return {
    placements: [{ sheet: 0, sheetid: "0000-0000", sheetplacements: spots }],
    utilisation: utilisation,
    fitness: 1000 - count,
    selected: true,
  };
}

test("a failed 12 step restores the 11 nest, its count, and its utilisation", () => {
  const fit = nestFor(11, 71.4, false);
  const parts = partsAt(11);
  // The panel is bound to this array. Restoring must not replace it.
  const nests = [fit];
  const panel = nests;

  const saved = Result.rememberFullFit(fit, [0, 11, 11, 11]);
  fit.utilisation = 60.17;
  fit.placements[0].sheetplacements[0].x = 999;
  fit.placements[0].sheetplacements.push({
    id: 0,
    source: 1,
    x: 0,
    y: 0,
    rotation: 0,
    width: 10,
    height: 10,
  });

  parts.forEach((part) => {
    if (!part.sheet) part.quantity = 12;
  });
  const failed = nestFor(12, 60.17, true);
  nests.splice(0, nests.length, failed);

  const restored = Result.restoreFullFit(nests, parts, saved);

  assert.equal(panel, nests);
  assert.equal(nests.length, 1);
  assert.equal(nests[0], restored);
  assert.equal(nests[0].selected, true);
  assert.equal(Result.partTotal(parts), 33);
  assert.equal(Result.placedCount(nests[0]), 33);
  assert.equal(nests[0].utilisation, 71.4);
  assert.deepEqual(Result.duplicateIds(nests[0]), []);
  assert.deepEqual(Result.overlappingPairs(nests[0]), []);
  assert.equal(nests[0].placements[0].sheetplacements[0].x, 0);
  assert.notEqual(nests[0], failed);
  assert.equal(Result.placedCount(failed) > 33, true);
});
