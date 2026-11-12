/**
 * Snapshot and restore of a max-out nest.
 *
 * The nests array is the same object the results panel is bound to, so a
 * restore has to edit that array in place. The saved nest is a deep copy:
 * later placement writes must not move its parts or its utilisation.
 */
"use strict";

function cloneNest(nest) {
  var copy = JSON.parse(JSON.stringify(nest));
  copy.selected = true;
  return copy;
}

function rememberFullFit(nest, quantities) {
  if (!nest) return null;
  return {
    nest: cloneNest(nest),
    quantities: (quantities || []).slice(),
  };
}

function writeQuantities(parts, quantities) {
  if (!parts || !quantities) return;
  for (var i = 0; i < parts.length && i < quantities.length; i++) {
    if (parts[i].sheet) continue;
    if (typeof quantities[i] === "number") parts[i].quantity = quantities[i];
  }
}

function partTotal(parts) {
  var total = 0;
  (parts || []).forEach(function (part) {
    if (!part.sheet) total += part.quantity || 0;
  });
  return total;
}

function placedCount(nest) {
  var count = 0;
  var placements = (nest && nest.placements) || [];
  for (var i = 0; i < placements.length; i++) {
    count += ((placements[i] && placements[i].sheetplacements) || []).length;
  }
  return count;
}

function placementIds(nest) {
  var ids = [];
  var placements = (nest && nest.placements) || [];
  for (var i = 0; i < placements.length; i++) {
    var spots = placements[i].sheetplacements || [];
    for (var j = 0; j < spots.length; j++) ids.push(spots[j].id);
  }
  return ids;
}

function duplicateIds(nest) {
  var seen = {};
  var dupes = [];
  placementIds(nest).forEach(function (id) {
    var key = String(id);
    if (seen[key]) dupes.push(id);
    seen[key] = true;
  });
  return dupes;
}

function boxesOverlap(a, b) {
  var aw = a.width > 0 ? a.width : 0;
  var ah = a.height > 0 ? a.height : 0;
  var bw = b.width > 0 ? b.width : 0;
  var bh = b.height > 0 ? b.height : 0;
  if (!(aw > 0) || !(ah > 0) || !(bw > 0) || !(bh > 0)) return false;
  return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y;
}

function overlappingPairs(nest) {
  var spots = [];
  var placements = (nest && nest.placements) || [];
  for (var i = 0; i < placements.length; i++) {
    (placements[i].sheetplacements || []).forEach(function (spot) {
      spots.push(spot);
    });
  }
  var pairs = [];
  for (var a = 0; a < spots.length; a++) {
    for (var b = a + 1; b < spots.length; b++) {
      if (boxesOverlap(spots[a], spots[b])) pairs.push([spots[a].id, spots[b].id]);
    }
  }
  return pairs;
}

/**
 * Put the saved full-fit nest back into the panel's array and the part list.
 * `nests` is mutated, not replaced.
 */
function restoreFullFit(nests, parts, saved) {
  if (!nests || !saved || !saved.nest) return null;
  writeQuantities(parts, saved.quantities);
  var restored = cloneNest(saved.nest);
  restored.selected = true;
  nests.splice(0, nests.length, restored);
  return restored;
}

module.exports = {
  cloneNest: cloneNest,
  rememberFullFit: rememberFullFit,
  writeQuantities: writeQuantities,
  partTotal: partTotal,
  placedCount: placedCount,
  duplicateIds: duplicateIds,
  overlappingPairs: overlappingPairs,
  restoreFullFit: restoreFullFit,
};
