"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Distribution = require("../main/util/distribution.js");

function sheet(width, height, quantity) {
  return {
    sheet: true,
    filename: "sheet",
    width: width,
    height: height,
    area: width * height,
    quantity: quantity == null ? 1 : quantity,
    percent: null,
  };
}

function part(name, width, height, percent) {
  return {
    sheet: false,
    filename: name,
    width: width,
    height: height,
    area: width * height,
    quantity: 1,
    percent: percent == null ? null : percent,
  };
}

test("even part count keeps whole sets and drops the leftover", () => {
  const plan = Distribution.planPartCount({
    even: true,
    total: 10,
    rotations: 4,
    items: [sheet(48, 10), part("chef", 12, 2), part("utility", 8, 1.2), part("paring", 6, 1)],
  });
  assert.deepEqual(plan.quantities.slice(1), [3, 3, 3]);
  assert.equal(plan.dropped, 1);
  assert.equal(plan.raised, false);
  assert.equal(plan.totalParts, 9);
  assert.match(plan.hint, /3 of each/);
  assert.match(plan.hint, /leaves 1 uncut/);
});

test("even part count raises a short total to one full set", () => {
  const plan = Distribution.planPartCount({
    even: true,
    total: 2,
    rotations: 4,
    items: [sheet(48, 10), part("a", 4, 1), part("b", 4, 1), part("c", 4, 1)],
  });
  assert.deepEqual(plan.quantities.slice(1), [1, 1, 1]);
  assert.equal(plan.raised, true);
  assert.match(plan.hint, /raised to 3/);
});

test("percentages split a total and give every positive share at least one", () => {
  const exact = Distribution.allocateExact(10, [50, 30, 20]);
  assert.deepEqual(exact, [5, 3, 2]);

  const small = Distribution.allocateExact(10, [1, 1, 98]);
  assert.deepEqual(small, [1, 1, 8]);
  assert.equal(small.reduce((s, n) => s + n, 0), 10);

  const tooSmall = Distribution.allocateExact(2, [50, 30, 20]);
  assert.equal(tooSmall, null);

  const plan = Distribution.planPartCount({
    even: false,
    total: 10,
    rotations: 4,
    items: [sheet(48, 10), part("chef", 12, 2, 50), part("utility", 8, 1.2, 30), part("paring", 6, 1, 20)],
  });
  assert.deepEqual(plan.quantities.slice(1), [5, 3, 2]);
  assert.equal(plan.normalized, false);
});

test("percentages that do not sum to 100 are used as shares, not rewritten", () => {
  const plan = Distribution.planPartCount({
    even: false,
    total: 10,
    rotations: 4,
    items: [sheet(48, 10), part("a", 4, 1, 40), part("b", 4, 1, 40)],
  });
  assert.deepEqual(plan.quantities.slice(1), [5, 5]);
  assert.equal(plan.percentSum, 80);
  assert.equal(plan.normalized, true);
  assert.match(plan.hint, /80%/);
});

test("a zero percentage is left out, and a short total is raised so the others get one", () => {
  const plan = Distribution.planPartCount({
    even: false,
    total: 1,
    rotations: 4,
    items: [sheet(48, 10), part("a", 4, 1, 50), part("b", 4, 1, 0), part("c", 4, 1, 50)],
  });
  assert.deepEqual(plan.quantities.slice(1), [1, 0, 1]);
  assert.equal(plan.raised, true);
  assert.equal(plan.totalParts, 2);
});

test("a part that fits on no sheet is left at zero", () => {
  const plan = Distribution.planPartCount({
    even: true,
    total: 6,
    rotations: 4,
    items: [sheet(10, 4), part("fits", 3, 1), part("too tall", 2, 12)],
  });
  assert.equal(plan.quantities[1], 6);
  assert.equal(plan.quantities[2], 0);
  assert.match(plan.hint, /too tall/);
  assert.equal(Distribution.partFitsSheets({ width: 2, height: 12 }, [{ width: 10, height: 4 }], 4), false);
  assert.equal(Distribution.partFitsSheets({ width: 2, height: 12 }, [{ width: 10, height: 4 }], 2), false);
  assert.equal(Distribution.chooseRotation({ width: 12, height: 2 }, [{ width: 10, height: 48 }], 4), 90);
});

test("blank total does not invent quantities", () => {
  const plan = Distribution.planPartCount({
    even: true,
    total: null,
    rotations: 4,
    items: [sheet(48, 10), part("a", 4, 1), part("b", 4, 1)],
  });
  assert.equal(plan.quantities, null);
  assert.equal(plan.ok, false);
  assert.match(plan.hint, /total part count/i);
});

test("max out even search stays on equal counts", () => {
  const items = [sheet(48, 10), part("a", 4, 1), part("b", 4, 1), part("c", 4, 1)];
  const result = Distribution.runMaxOut({ even: true, rotations: 4, items: items }, function (sequence) {
    const counts = {};
    sequence.forEach((index) => {
      counts[index] = (counts[index] || 0) + 1;
    });
    const values = Object.keys(counts).map((key) => counts[key]);
    assert.equal(new Set(values).size, 1, "even search must not try unequal counts");
    return values[0] <= 4;
  });
  assert.equal(result.level, 4);
  assert.deepEqual(result.quantities.slice(1), [4, 4, 4]);
  assert.match(result.hint, /4 of each/);
  assert.match(result.hint, /equal/);
});

test("max out percentages take the largest total whose split still fits", () => {
  const items = [sheet(100, 100), part("a", 1, 1, 50), part("b", 1, 1, 30), part("c", 1, 1, 20)];
  const result = Distribution.runMaxOut({ even: false, rotations: 1, items: items }, function (sequence) {
    return sequence.length <= 12;
  });
  assert.equal(result.totalParts, 12);
  assert.deepEqual(result.quantities.slice(1), Distribution.allocateExact(12, [50, 30, 20]));
  assert.equal(result.quantities.slice(1).reduce((s, n) => s + n, 0), 12);
});

test("max out returns zero when even one set does not fit", () => {
  const items = [sheet(10, 10), part("a", 4, 4), part("b", 4, 4)];
  const result = Distribution.runMaxOut({ even: true, rotations: 1, items: items }, function () {
    return false;
  });
  assert.equal(result.level, 0);
  assert.equal(result.totalParts, 0);
  assert.match(result.hint, /Nothing from this mix fits/);
});

test("equal percents sum to 100", () => {
  [1, 2, 3, 7].forEach((n) => {
    const shares = Distribution.equalPercents(n);
    const sum = shares.reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 100) < 0.02, "n=" + n + " summed to " + sum);
  });
});

test("search is monotonic and respects the minimum level", () => {
  assert.equal(
    Distribution.searchMaxLevel(10, (level) => level <= 4, 1),
    4
  );
  assert.equal(
    Distribution.searchMaxLevel(10, () => false, 1),
    0
  );
  assert.equal(
    Distribution.searchMaxLevel(2, () => true, 3),
    0
  );
});
