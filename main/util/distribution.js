/**
 * Part-mix planner.
 *
 * Deepnest nests an integer quantity of each part. This module turns a
 * distribution (even, or percentages) into those quantities. It does not
 * place polygons. "Max out" asks the caller which counts actually fit.
 *
 * Even counts stay equal: a set is one of each design, and leftovers that
 * would make one design run ahead of the others are not added.
 * Percentages use the closest integer split (largest remainder). Each part
 * with a share above 0 gets at least one when the total is large enough.
 * Parts that fit on no sheet are left at 0.
 *
 * Works in the Electron renderer (require) and in Node unit tests.
 */
"use strict";

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.NestDistribution = api;
  }
})(typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : this, function () {
  var MAX_FIT_LEVEL = 80;
  var FIT_EPSILON = 1e-6;

  function num(value, fallback) {
    var n = Number(value);
    if (typeof n !== "number" || !isFinite(n)) {
      return fallback;
    }
    return n;
  }

  function labelOf(items, index) {
    var item = items[index];
    var name = item && item.filename ? String(item.filename) : "part";
    var same = 0;
    var seen = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i].sheet) continue;
      if ((items[i].filename || "part") === (item && item.filename ? String(item.filename) : "part")) {
        same++;
        if (i <= index) seen++;
      }
    }
    if (same > 1) return name + " #" + seen;
    return name;
  }

  function rotatedSize(width, height, degrees) {
    var rad = num(degrees, 0) * Math.PI / 180;
    var c = Math.abs(Math.cos(rad));
    var s = Math.abs(Math.sin(rad));
    return {
      width: num(width, 0) * c + num(height, 0) * s,
      height: num(width, 0) * s + num(height, 0) * c,
    };
  }

  function polygonBounds(points) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    var list = points || [];
    for (var i = 0; i < list.length; i++) {
      var x = num(list[i].x, 0);
      var y = num(list[i].y, 0);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!isFinite(minX)) {
      return { width: 0, height: 0, area: 0 };
    }
    var width = maxX - minX;
    var height = maxY - minY;
    return { width: width, height: height, area: width * height };
  }

  function rotationCount(value) {
    var n = Math.floor(num(value, 1));
    if (!(n > 0)) n = 1;
    return n;
  }

  function sheetList(items) {
    var sheets = [];
    (items || []).forEach(function (item) {
      if (!item.sheet) return;
      var q = Math.floor(num(item.quantity, 0));
      if (!(q > 0)) return;
      sheets.push({
        width: num(item.width, 0),
        height: num(item.height, 0),
        area: num(item.area, 0) > 0 ? num(item.area, 0) : num(item.width, 0) * num(item.height, 0),
        quantity: q,
      });
    });
    return sheets;
  }

  function sizeFits(size, sheet) {
    return size.width <= sheet.width + FIT_EPSILON && size.height <= sheet.height + FIT_EPSILON;
  }

  function partFitsSheets(part, sheets, rotations) {
    var n = rotationCount(rotations);
    var list = sheets || [];
    if (!part || list.length === 0) return false;
    for (var k = 0; k < n; k++) {
      var size = rotatedSize(part.width, part.height, k * (360 / n));
      for (var s = 0; s < list.length; s++) {
        if (sizeFits(size, list[s])) return true;
      }
    }
    return false;
  }

  function chooseRotation(part, sheets, rotations) {
    var n = rotationCount(rotations);
    var list = sheets || [];
    var best = null;
    for (var k = 0; k < n; k++) {
      var angle = k * (360 / n);
      var size = rotatedSize(part.width, part.height, angle);
      var fits = false;
      var penalty = 0;
      for (var s = 0; s < list.length; s++) {
        if (!sizeFits(size, list[s])) continue;
        fits = true;
        penalty += list[s].width >= list[s].height ? size.height : size.width;
      }
      if (!fits) continue;
      if (
        !best ||
        penalty < best.penalty - FIT_EPSILON ||
        (Math.abs(penalty - best.penalty) <= FIT_EPSILON && angle < best.angle)
      ) {
        best = { angle: angle, penalty: penalty };
      }
    }
    return best ? best.angle : 0;
  }

  function equalPercents(count) {
    var n = Math.floor(num(count, 0));
    if (!(n > 0)) return [];
    var percents = [];
    var used = 0;
    for (var i = 0; i < n; i++) {
      var share = Math.round((100 / n) * 100) / 100;
      percents.push(share);
      used += share;
    }
    var drift = Math.round((100 - used) * 100) / 100;
    percents[n - 1] = Math.round((percents[n - 1] + drift) * 100) / 100;
    return percents;
  }

  /**
   * Closest integer split of `total` across positive weights.
   * Returns null when total is smaller than the number of positive weights,
   * because each of those parts must get at least one.
   */
  function allocateExact(total, weights) {
    var requested = Math.floor(num(total, 0));
    var active = [];
    var counts = (weights || []).map(function () {
      return 0;
    });
    (weights || []).forEach(function (weight, index) {
      if (num(weight, 0) > 0) active.push({ index: index, weight: num(weight, 0) });
    });
    if (active.length === 0) return counts;
    if (requested < active.length) return null;

    active.forEach(function (entry) {
      counts[entry.index] = 1;
    });
    var remaining = requested - active.length;
    if (remaining === 0) return counts;

    var weightSum = 0;
    active.forEach(function (entry) {
      weightSum += entry.weight;
    });
    var used = 0;
    var fractions = active.map(function (entry) {
      var raw = (remaining * entry.weight) / weightSum;
      var whole = Math.floor(raw + 1e-9);
      used += whole;
      counts[entry.index] += whole;
      return { index: entry.index, frac: raw - whole };
    });
    fractions.sort(function (a, b) {
      if (Math.abs(b.frac - a.frac) > 1e-9) return b.frac - a.frac;
      return a.index - b.index;
    });
    var left = remaining - used;
    for (var i = 0; i < left; i++) {
      counts[fractions[i % fractions.length].index] += 1;
    }
    return counts;
  }

  function expandSequence(entries, order) {
    var seq = [];
    var list = entries || [];
    if (order === "grouped") {
      list.forEach(function (entry) {
        for (var i = 0; i < entry.count; i++) seq.push(entry.index);
      });
      return seq;
    }
    var left = list.map(function (entry) {
      return entry.count;
    });
    var total = 0;
    left.forEach(function (n) {
      total += n;
    });
    var guard = 0;
    while (total > 0 && guard < 100000) {
      for (var i = 0; i < list.length; i++) {
        if (left[i] > 0) {
          seq.push(list[i].index);
          left[i]--;
          total--;
        }
      }
      guard++;
    }
    return seq;
  }

  function analyze(items, rotations) {
    var list = items || [];
    var sheets = sheetList(list);
    var sheetArea = 0;
    sheets.forEach(function (sheet) {
      sheetArea += sheet.area * sheet.quantity;
    });
    var parts = [];
    list.forEach(function (item, index) {
      if (item.sheet) return;
      var width = num(item.width, 0);
      var height = num(item.height, 0);
      var area = num(item.area, 0) > 0 ? num(item.area, 0) : width * height;
      var fits = partFitsSheets({ width: width, height: height }, sheets, rotations);
      var percent = item.percent == null || item.percent === "" ? null : num(item.percent, 0);
      parts.push({
        index: index,
        filename: item.filename,
        width: width,
        height: height,
        area: area,
        fits: fits,
        percent: percent,
        rotation: fits ? chooseRotation({ width: width, height: height }, sheets, rotations) : 0,
      });
    });
    return { items: list, sheets: sheets, sheetArea: sheetArea, parts: parts };
  }

  function eligibleParts(info, even) {
    return info.parts.filter(function (part) {
      if (!part.fits) return false;
      if (even) return true;
      return part.percent != null && part.percent > 0;
    });
  }

  function excludedNames(info, items) {
    var names = [];
    info.parts.forEach(function (part) {
      if (!part.fits) names.push(labelOf(items, part.index));
    });
    return names;
  }

  function blankQuantities(items) {
    return (items || []).map(function (item) {
      return item.sheet ? Math.max(0, Math.floor(num(item.quantity, 0))) : 0;
    });
  }

  function applyPartCounts(items, partCounts) {
    var quantities = blankQuantities(items);
    Object.keys(partCounts).forEach(function (key) {
      quantities[Number(key)] = partCounts[key];
    });
    return quantities;
  }

  function sumCounts(quantities, items) {
    var total = 0;
    (quantities || []).forEach(function (count, index) {
      if (!items[index].sheet) total += count;
    });
    return total;
  }

  function rotationMap(info) {
    var map = {};
    info.parts.forEach(function (part) {
      map[part.index] = part.rotation;
    });
    return map;
  }

  function sequenceFromQuantities(quantities, items) {
    var entries = [];
    (quantities || []).forEach(function (count, index) {
      if (items[index].sheet || !(count > 0)) return;
      entries.push({ index: index, count: count });
    });
    return expandSequence(entries, "robin");
  }

  function percentSum(info) {
    var sum = 0;
    var unset = 0;
    info.parts.forEach(function (part) {
      if (part.percent == null) {
        unset++;
        return;
      }
      if (part.percent > 0) sum += part.percent;
    });
    return { sum: sum, unset: unset };
  }

  function listSplit(items, quantities) {
    var bits = [];
    items.forEach(function (item, index) {
      if (item.sheet) return;
      if (!(quantities[index] > 0)) return;
      bits.push(labelOf(items, index) + " " + quantities[index]);
    });
    return bits.join(", ");
  }

  function planPartCount(input) {
    var even = !!(input && input.even);
    var rotations = input && input.rotations;
    var info = analyze((input && input.items) || [], rotations);
    var items = info.items;
    var quantities = blankQuantities(items);
    var eligible = eligibleParts(info, even);
    var excluded = excludedNames(info, items);
    var shares = percentSum(info);
    var totalRaw = input ? input.total : null;
    var totalMissing = totalRaw == null || totalRaw === "";
    var requested = totalMissing ? null : Math.floor(num(totalRaw, 0));
    var hint = [];
    var raised = false;
    var dropped = 0;

    if (excluded.length) {
      hint.push(
        excluded.join(", ") +
          (excluded.length === 1 ? " is" : " are") +
          " larger than every sheet, so " +
          (excluded.length === 1 ? "it is" : "they are") +
          " left out."
      );
    }

    if (!even && shares.unset > 0) {
      hint.push(
        shares.unset +
          (shares.unset === 1 ? " part has" : " parts have") +
          " no percentage yet, so " +
          (shares.unset === 1 ? "its quantity is" : "their quantities are") +
          " 0."
      );
    }

    if (eligible.length === 0) {
      hint.push(even ? "No designs fit on the sheets." : "Enter a percentage above 0 for at least one part that fits.");
      return finishPartCount(items, quantities, info, {
        hint: hint,
        ok: false,
        requested: requested,
        raised: false,
        dropped: 0,
        even: even,
        shares: shares,
      });
    }

    if (totalMissing) {
      hint.push("Enter a total part count, or switch to Max out the sheets.");
      return finishPartCount(items, null, info, {
        hint: hint,
        ok: false,
        requested: null,
        raised: false,
        dropped: 0,
        even: even,
        shares: shares,
      });
    }

    if (!(requested > 0)) {
      hint.push("Total is 0, so nothing will be cut.");
      return finishPartCount(items, quantities, info, {
        hint: hint,
        ok: false,
        requested: 0,
        raised: false,
        dropped: 0,
        even: even,
        shares: shares,
      });
    }

    var partCounts = {};
    if (even) {
      var per = Math.floor(requested / eligible.length);
      dropped = requested - per * eligible.length;
      if (per < 1) {
        per = 1;
        dropped = 0;
        raised = true;
      }
      eligible.forEach(function (part) {
        partCounts[part.index] = per;
      });
      quantities = applyPartCounts(items, partCounts);
      if (raised) {
        hint.push(
          "Total was raised to " +
            eligible.length +
            " so each design gets one. Counts stay equal."
        );
      } else if (dropped > 0) {
        hint.push(
          "Total " +
            requested +
            " is not a whole set, so this cuts " +
            per +
            " of each (" +
            per * eligible.length +
            " parts) and leaves " +
            dropped +
            " uncut."
        );
      } else {
        hint.push(per + " of each design (" + per * eligible.length + " parts).");
      }
    } else {
      var weightList = [];
      eligible.forEach(function (part) {
        weightList.push(part.percent);
      });
      var usedTotal = requested;
      var allocated = allocateExact(requested, weightList);
      if (!allocated) {
        allocated = allocateExact(eligible.length, weightList);
        usedTotal = eligible.length;
        raised = true;
      }
      eligible.forEach(function (part, i) {
        partCounts[part.index] = allocated[i];
      });
      quantities = applyPartCounts(items, partCounts);
      if (Math.abs(shares.sum - 100) > 0.05 && shares.sum > 0) {
        hint.push(
          "Percentages add up to " +
            round1(shares.sum) +
            "%. Each count is that part's share of " +
            round1(shares.sum) +
            "%, not of 100."
        );
      }
      if (raised) {
        hint.push(
          "Total was raised to " +
            usedTotal +
            " so every part with a percentage gets at least one."
        );
      }
      hint.push("Split: " + listSplit(items, quantities) + ".");
    }

    hint.push("Packed toward one edge so the rest of the sheet stays in one piece.");

    return finishPartCount(items, quantities, info, {
      hint: hint,
      ok: sumCounts(quantities, items) > 0,
      requested: requested,
      raised: raised,
      dropped: dropped,
      even: even,
      shares: shares,
    });
  }

  function finishPartCount(items, quantities, info, state) {
    var totalParts = quantities ? sumCounts(quantities, items) : 0;
    return {
      quantities: quantities,
      totalParts: totalParts,
      requestedTotal: state.requested,
      dropped: state.dropped,
      raised: state.raised,
      percentSum: state.even ? null : state.shares.sum,
      normalized: !state.even && state.shares.sum > 0 && Math.abs(state.shares.sum - 100) > 0.05,
      excluded: excludedNames(info, items),
      unsetPercent: state.even ? 0 : state.shares.unset,
      hint: state.hint.filter(Boolean).join(" "),
      ok: state.ok,
      sequence: quantities ? sequenceFromQuantities(quantities, items) : [],
      rotationByIndex: rotationMap(info),
      even: state.even,
    };
  }

  function maxOutSearch(input) {
    var even = !input || input.even !== false;
    var info = analyze((input && input.items) || [], input && input.rotations);
    var items = info.items;
    var eligible = eligibleParts(info, even);
    var minArea = Infinity;
    var setArea = 0;
    eligible.forEach(function (part) {
      var area = part.area > 0 ? part.area : part.width * part.height;
      setArea += area;
      if (area > 0 && area < minArea) minArea = area;
    });
    var areaCap = 0;
    if (info.sheetArea > 0 && minArea < Infinity && minArea > 0) {
      areaCap = Math.floor(info.sheetArea / minArea);
    }
    var minLevel = even ? (eligible.length ? 1 : 0) : eligible.length;
    var ceiling = Math.min(MAX_FIT_LEVEL, Math.max(minLevel, areaCap));
    if (eligible.length === 0) ceiling = 0;

    var areaGuess = 0;
    if (even && setArea > 0) {
      areaGuess = Math.floor(info.sheetArea / setArea);
    } else if (!even && eligible.length && setArea > 0) {
      areaGuess = Math.floor(info.sheetArea / (setArea / eligible.length));
    }
    if (areaGuess < 0) areaGuess = 0;

    function countsForLevel(level) {
      var quantities = blankQuantities(items);
      var n = Math.floor(num(level, 0));
      if (!(n > 0) || eligible.length === 0) return quantities;
      if (even) {
        eligible.forEach(function (part) {
          quantities[part.index] = n;
        });
        return quantities;
      }
      var weights = eligible.map(function (part) {
        return part.percent;
      });
      var allocated = allocateExact(n, weights);
      if (!allocated) return null;
      eligible.forEach(function (part, i) {
        quantities[part.index] = allocated[i];
      });
      return quantities;
    }

    function hintFor(level, quantities) {
      var lines = [];
      var excluded = excludedNames(info, items);
      if (excluded.length) {
        lines.push(
          excluded.join(", ") +
            (excluded.length === 1 ? " is" : " are") +
            " larger than every sheet, so " +
            (excluded.length === 1 ? "it is" : "they are") +
            " left out."
        );
      }
      if (!(level > 0) || !quantities) {
        lines.push("Nothing from this mix fits on the sheets.");
        return lines.join(" ");
      }
      var total = sumCounts(quantities, items);
      if (even) {
        lines.push(
          level +
            " of each design (" +
            total +
            " parts). Counts stay equal, so they can be made in sets. No extra of one design was added."
        );
      } else {
        var shares = percentSum(info);
        if (shares.sum > 0 && Math.abs(shares.sum - 100) > 0.05) {
          lines.push(
            "Percentages add up to " +
              round1(shares.sum) +
              "%. Counts use each share of that total."
          );
        }
        lines.push(
          total +
            " parts (" +
            listSplit(items, quantities) +
            "). That is as close to the percentages as whole parts allow, without adding extras past the mix."
        );
      }
      return lines.join(" ");
    }

    function roughHint() {
      if (eligible.length === 0) {
        var excluded = excludedNames(info, items);
        if (excluded.length) {
          return excluded.join(", ") + " cannot fit on the sheets.";
        }
        return even
          ? "Add at least one design that fits on the sheet."
          : "Enter a percentage above 0 for each design you want in the mix.";
      }
      if (even) {
        return (
          "Bounding-box guess: about " +
          areaGuess +
          " of each. Nesting starts from a count that fits, then adds one more of each design whenever every part is placed and the search levels off."
        );
      }
      return "Start nest places as many parts as fit while staying as close as possible to these percentages. It will not add extras past the mix.";
    }

    return {
      ceiling: ceiling,
      minLevel: minLevel,
      areaGuess: areaGuess,
      even: even,
      countsForLevel: countsForLevel,
      hintFor: hintFor,
      roughHint: roughHint,
      rotationByIndex: rotationMap(info),
      items: items,
    };
  }

  function searchMaxLevel(ceiling, fits, minLevel) {
    var cap = Math.floor(num(ceiling, 0));
    var min = Math.floor(num(minLevel, 1));
    if (!(min > 0)) min = 1;
    if (!(cap >= min)) return 0;
    var cache = {};
    function check(level) {
      if (level < min) return false;
      if (level > cap) return false;
      var key = String(level);
      if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
      var ok = false;
      try {
        ok = !!fits(level);
      } catch (err) {
        ok = false;
      }
      cache[key] = ok;
      return ok;
    }
    if (!check(min)) return 0;
    var best = min;
    var hi = min;
    while (hi < cap) {
      var next = Math.min(cap, hi * 2);
      if (next === hi) break;
      if (!check(next)) {
        hi = next;
        break;
      }
      best = next;
      hi = next;
      if (hi === cap) return cap;
    }
    var lo = best;
    while (lo + 1 < hi) {
      var mid = Math.floor((lo + hi) / 2);
      if (check(mid)) lo = mid;
      else hi = mid;
    }
    return check(lo) ? lo : 0;
  }

  function runMaxOut(input, places) {
    var plan = maxOutSearch(input);
    var success = {};
    function fits(level) {
      var counts = plan.countsForLevel(level);
      if (!counts) return false;
      var entries = [];
      counts.forEach(function (count, index) {
        if (plan.items[index].sheet || !(count > 0)) return;
        entries.push({ index: index, count: count });
      });
      if (entries.length === 0) return false;
      var robin = expandSequence(entries, "robin");
      if (places(robin, plan.rotationByIndex)) {
        success[level] = { sequence: robin, order: "robin", counts: counts };
        return true;
      }
      var grouped = expandSequence(entries, "grouped");
      if (places(grouped, plan.rotationByIndex)) {
        success[level] = { sequence: grouped, order: "grouped", counts: counts };
        return true;
      }
      return false;
    }
    var level = searchMaxLevel(plan.ceiling, fits, plan.minLevel);
    var won = success[level] || {
      sequence: [],
      order: null,
      counts: plan.countsForLevel(0),
    };
    var quantities = won.counts || plan.countsForLevel(0);
    return {
      level: level,
      quantities: quantities,
      totalParts: sumCounts(quantities, plan.items),
      sequence: won.sequence,
      order: won.order,
      rotationByIndex: plan.rotationByIndex,
      hint: plan.hintFor(level, quantities),
      ceiling: plan.ceiling,
      areaGuess: plan.areaGuess,
      even: plan.even,
    };
  }

  function tryingStatus(plan, level, quantities, total) {
    if (plan.even) {
      return "Trying " + level + " of each (" + total + " parts)...";
    }
    return "Trying " + total + " parts (" + listSplit(plan.items, quantities) + ")...";
  }

  function finalStatus(plan, level, quantities, total, failedLevel, reason) {
    if (!(level > 0)) {
      return "Final: nothing from this mix fit on the sheets.";
    }
    var head = plan.even
      ? "Final: " + level + " of each (" + total + " parts)"
      : "Final: " + total + " parts (" + listSplit(plan.items, quantities) + ")";
    if (reason === "overflow" && failedLevel) {
      if (plan.even) {
        head += " - " + failedLevel + " would not fit";
      } else {
        var failedCounts = plan.countsForLevel(failedLevel);
        head += " - " + sumCounts(failedCounts, plan.items) + " would not fit";
      }
    }
    return head;
  }

  // Max-out only. Starts at a count that is worth trying, then steps up after
  // a full placement. A step that does not place everything ends the search
  // on the largest count that did.
  function createMaxOutEscalation(plan, options) {
    var minLevel = Math.max(1, Math.floor(num(plan && plan.minLevel, 1)));
    var ceiling = Math.floor(num(plan && plan.ceiling, 0));
    var start = Math.floor(num(options && options.startLevel, 0));
    if (!(start >= minLevel)) {
      var guess = Math.floor(num(plan && plan.areaGuess, 0));
      start = guess >= minLevel ? guess : minLevel;
    }
    if (ceiling > 0 && start > ceiling) start = ceiling;
    if (!(start > 0) || !plan || typeof plan.countsForLevel !== "function") start = 0;

    var trying = start;
    var bestFull = null;
    var highFail = null;
    var finished = null;

    function pack(level) {
      var quantities = plan.countsForLevel(level);
      var total = sumCounts(quantities, plan.items);
      return {
        action: "try",
        level: level,
        quantities: quantities,
        totalParts: total,
        sequence: sequenceFromQuantities(quantities, plan.items),
        status: tryingStatus(plan, level, quantities, total),
      };
    }

    function done(reason) {
      var level = bestFull == null ? 0 : bestFull;
      var quantities = plan.countsForLevel(level > 0 ? level : 0);
      var total = sumCounts(quantities, plan.items);
      var keepCurrent = reason === "stopped" && !(bestFull > 0);
      if (keepCurrent) {
        level = trying;
        quantities = plan.countsForLevel(trying > 0 ? trying : 0);
        total = sumCounts(quantities, plan.items);
      }
      finished = {
        action: "done",
        reason: reason,
        level: keepCurrent ? 0 : level,
        quantities: quantities,
        totalParts: total,
        failedLevel: reason === "overflow" ? highFail : null,
        keepCurrent: keepCurrent,
        status: keepCurrent
          ? "Stopped while trying " +
            (plan.even ? trying + " of each (" + total + " parts)" : total + " parts") +
            "."
          : finalStatus(plan, level, quantities, total, reason === "overflow" ? highFail : null, reason),
      };
      return finished;
    }

    return {
      begin: function () {
        if (finished) return finished;
        if (!(trying > 0)) return done("none");
        return pack(trying);
      },
      onResult: function (allPlaced) {
        if (finished) return finished;
        if (allPlaced) {
          bestFull = trying;
          var upper = highFail == null ? (ceiling > 0 ? ceiling + 1 : trying + 2) : highFail;
          if (ceiling > 0) upper = Math.min(upper, ceiling + 1);
          if (bestFull + 1 >= upper) {
            return done(highFail == null ? "ceiling" : "overflow");
          }
          var next = bestFull + 1;
          if (highFail != null) {
            var jump = Math.floor((highFail - bestFull) / 2);
            if (jump < 1) jump = 1;
            next = bestFull + jump;
            if (next >= highFail) return done("overflow");
          }
          trying = next;
          return pack(trying);
        }
        if (highFail == null || trying < highFail) highFail = trying;
        if (bestFull != null) return done("overflow");
        if (trying <= minLevel) return done("none");
        var nextDown = Math.floor(trying / 2);
        if (nextDown < minLevel) nextDown = trying - 1;
        if (!(nextDown >= minLevel) || nextDown >= trying) return done("none");
        trying = nextDown;
        return pack(trying);
      },
      noteFit: function () {
        if (!finished && trying > 0) bestFull = trying;
      },
      stop: function () {
        if (finished) return finished;
        return done("stopped");
      },
    };
  }

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  return {
    MAX_FIT_LEVEL: MAX_FIT_LEVEL,
    equalPercents: equalPercents,
    rotatedSize: rotatedSize,
    polygonBounds: polygonBounds,
    partFitsSheets: partFitsSheets,
    chooseRotation: chooseRotation,
    allocateExact: allocateExact,
    expandSequence: expandSequence,
    planPartCount: planPartCount,
    maxOutSearch: maxOutSearch,
    searchMaxLevel: searchMaxLevel,
    runMaxOut: runMaxOut,
    createMaxOutEscalation: createMaxOutEscalation,
  };
});
