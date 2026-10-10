#!/usr/bin/env node
/**
 * Headless nest benchmark.
 *
 * Loads the real placement engine (main/background.js) without Electron and
 * times a fixed set of parts, orders, and rotations. The schedule is seeded
 * so two checkouts of this script produce the same individuals.
 *
 * Quality (fitness, utilisation, sheets, parts placed) should match across
 * speed-only changes. Wall time is what should move.
 *
 *   node scripts/bench-nest.js
 *   node scripts/bench-nest.js --label main --out /tmp/bench-main.json
 *
 * Pair-scan: always times a reference copy of the old O(n) de-dupe, and also
 * times buildNfpPairs() when this checkout exports it.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) return fallback;
  return process.argv[i + 1];
}

const label = argValue("--label", "current");
const outPath = argValue("--out", "");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadEngine() {
  const context = {
    console,
    Math,
    Set,
    Date,
    JSON,
    Array,
    Object,
    Number,
    String,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
    navigator: {
      userAgent: "chrome",
      appName: "Netscape",
      hardwareConcurrency: 4,
    },
    ipcRenderer: { send() {} },
    addon: {
      calculateNFP() {
        throw new Error("native NFP addon was invoked; bench parts should stay on the clipper/rectangular path");
      },
    },
    process: { env: {} },
  };
  context.window = context;
  context.self = context;
  context.global = context;
  vm.createContext(context);

  function load(rel) {
    const filename = path.join(root, rel);
    vm.runInContext(fs.readFileSync(filename, "utf8"), context, { filename });
  }

  load("main/util/clipper.js");
  load("main/util/geometryutil.js");

  vm.runInContext(
    `
function NfpCache() { this.db = {}; }
NfpCache.prototype._key = function (doc) {
  var Arotation = parseInt(doc.Arotation, 10);
  var Brotation = parseInt(doc.Brotation, 10);
  var Aflipped = doc.Aflipped ? "1" : "0";
  var Bflipped = doc.Bflipped ? "1" : "0";
  return doc.A + "-" + doc.B + "-" + Arotation + "-" + Brotation + "-" + Aflipped + "-" + Bflipped;
};
NfpCache.prototype.has = function (doc) { return this._key(doc) in this.db; };
NfpCache.prototype.find = function (doc) {
  var value = this.db[this._key(doc)];
  if (!value) return null;
  return JSON.parse(JSON.stringify(value));
};
NfpCache.prototype.insert = function (doc) {
  this.db[this._key(doc)] = JSON.parse(JSON.stringify(doc.nfp));
};
NfpCache.prototype.getStats = function () { return Object.keys(this.db).length; };
function HullPolygon() {}
HullPolygon.hull = function () { return null; };
`,
    context,
    { filename: "bench-stubs.js" },
  );

  const background = fs
    .readFileSync(path.join(root, "main/background.js"), "utf8")
    .replace(/^import .*;\s*$/gm, "");
  vm.runInContext(background, context, { filename: path.join(root, "main/background.js") });
  return context;
}

function rect(x, y, w, h) {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

function lShape(x, y, w, h, t) {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + t],
    [x + t, y + t],
    [x + t, y + h],
    [x, y + h],
  ];
}

// Fixed shop-style mix: one rectangular plate and a handful of repeated parts.
// Coordinates are in the same abstract units the placement engine uses.
function sampleJob() {
  const specs = [
    { name: "plate", sheet: true, points: rect(0, 0, 600, 400), qty: 3 },
    { name: "panel", points: rect(0, 0, 140, 80), qty: 6 },
    { name: "strip", points: rect(0, 0, 180, 35), qty: 5 },
    { name: "square", points: rect(0, 0, 70, 70), qty: 4 },
    { name: "bracket", points: lShape(0, 0, 90, 70, 28), qty: 4 },
    { name: "gusset", points: lShape(0, 0, 60, 55, 18), qty: 3 },
  ];
  return specs;
}

function buildWorld(random) {
  const specs = sampleJob();
  const sheets = [];
  const parts = [];
  let source = 0;
  specs.forEach((spec) => {
    if (spec.sheet) {
      for (let q = 0; q < spec.qty; q++) {
        sheets.push({
          points: spec.points,
          id: "sheet-" + q,
          source,
          rotation: 0,
          filename: spec.name,
        });
      }
    } else {
      for (let q = 0; q < spec.qty; q++) {
        const rotationSteps = 4;
        const step = Math.floor(random() * rotationSteps);
        parts.push({
          points: spec.points,
          id: parts.length,
          source,
          rotation: step * (360 / rotationSteps),
          filename: spec.name,
        });
      }
    }
    source++;
  });

  // A few deterministic orderings. Index 0 is the input order (largest-first
  // is already roughly how Deepnest seeds the first individual).
  const orders = [parts.map((_, i) => i)];
  const byArea = parts
    .map((p, i) => ({ i, area: polygonArea(p.points) }))
    .sort((a, b) => b.area - a.area)
    .map((row) => row.i);
  orders.push(byArea);
  orders.push(byArea.slice().reverse());

  const shuffled = byArea.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }
  orders.push(shuffled);

  const rotated = parts.map((p) => (p.rotation + 90) % 360);
  return { sheets, parts, orders, rotated };
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
  }
  return Math.abs(area / 2);
}

function legacyPairCount(parts) {
  // Reference copy of the pre-change scan in background-start:
  // for every pair, walk the pairs collected so far.
  const pairs = [];
  const started = process.hrtime.bigint();
  function inpairs(key) {
    for (let i = 0; i < pairs.length; i++) {
      if (
        pairs[i].Asource === key.Asource &&
        pairs[i].Bsource === key.Bsource &&
        pairs[i].Arotation === key.Arotation &&
        pairs[i].Brotation === key.Brotation
      ) {
        return true;
      }
    }
    return false;
  }
  for (let i = 0; i < parts.length; i++) {
    const B = parts[i];
    for (let j = 0; j < i; j++) {
      const A = parts[j];
      const key = {
        Asource: A.source,
        Bsource: B.source,
        Arotation: A.rotation,
        Brotation: B.rotation,
      };
      if (!inpairs(key)) pairs.push(key);
    }
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { pairs: pairs.length, ms };
}

function uniqueParts(count) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    parts.push({
      source: i,
      rotation: (i % 4) * 90,
    });
  }
  return parts;
}

function timeEnginePairs(context, count) {
  if (!context.buildNfpPairs) return null;
  const parts = uniqueParts(count);
  const db = {
    has() {
      return false;
    },
  };
  const started = process.hrtime.bigint();
  const pairs = context.buildNfpPairs(parts, db);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { pairs: pairs.length, ms };
}

function summarizePlacement(result, totalParts) {
  const sheets = result && result.placements ? result.placements.length : 0;
  let placed = 0;
  if (result && result.placements) {
    result.placements.forEach((sheet) => {
      placed += sheet.sheetplacements.length;
    });
  }
  return {
    fitness: result ? result.fitness : null,
    utilisation: result && typeof result.utilisation === "number" ? result.utilisation : null,
    sheets,
    placed,
    unplaced: totalParts - placed,
  };
}

function main() {
  const random = mulberry32(20261010);
  const world = buildWorld(random);
  const context = loadEngine();

  const cfg = {
    clipperScale: 10000000,
    curveTolerance: 0.3,
    spacing: 0,
    rotations: 4,
    placementType: "gravity",
    mergeLines: false,
    timeRatio: 0.5,
    scale: 72,
    simplify: false,
    overlapTolerance: 0.0001,
  };

  context.cfg = cfg;
  context.window.db = new context.NfpCache();

  function toPoly(raw) {
    const poly = raw.points.map((pt) => ({ x: pt[0], y: pt[1] }));
    poly.id = raw.id;
    poly.source = raw.source;
    poly.rotation = raw.rotation;
    poly.filename = raw.filename;
    return poly;
  }

  function runIndividual(order, rotations) {
    const sheets = world.sheets.map(toPoly);
    const parts = order.map((index) => {
      const raw = world.parts[index];
      const poly = toPoly(raw);
      if (rotations) poly.rotation = rotations[index];
      return poly;
    });
    context.sheets = sheets;
    context.parts = parts;
    const started = process.hrtime.bigint();
    const result = vm.runInContext("placeParts(sheets, parts, cfg, 0)", context, {
      filename: "bench-call.js",
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { ms, summary: summarizePlacement(result, world.parts.length) };
  }

  const runs = [];

  // Cold cache.
  context.window.db = new context.NfpCache();
  runs.push(Object.assign({ phase: "cold", order: 0 }, runIndividual(world.orders[0], null)));

  // Warm cache: remaining fixed individuals, cache kept.
  world.orders.forEach((order, index) => {
    if (index === 0) return;
    runs.push(Object.assign({ phase: "warm", order: index }, runIndividual(order, null)));
  });
  runs.push(
    Object.assign(
      { phase: "warm", order: "rotated" },
      runIndividual(world.orders[1], world.rotated),
    ),
  );

  let best = null;
  runs.forEach((run) => {
    if (!best || run.summary.fitness < best.fitness) best = run.summary;
  });

  const coldMs = runs.filter((r) => r.phase === "cold").reduce((s, r) => s + r.ms, 0);
  const warmMs = runs.filter((r) => r.phase === "warm").reduce((s, r) => s + r.ms, 0);

  const pairN = 120;
  const legacyPairs = legacyPairCount(uniqueParts(pairN));
  const enginePairs = timeEnginePairs(context, pairN);

  const report = {
    label,
    seed: 20261010,
    parts: world.parts.length,
    sheetsAvailable: world.sheets.length,
    individuals: runs.length,
    coldMs: round(coldMs),
    warmMs: round(warmMs),
    totalMs: round(coldMs + warmMs),
    perIndividual: runs.map((run) => ({
      phase: run.phase,
      order: run.order,
      ms: round(run.ms),
      fitness: run.summary.fitness,
      utilisation: run.summary.utilisation === null ? null : round(run.summary.utilisation),
      sheets: run.summary.sheets,
      placed: run.summary.placed,
      unplaced: run.summary.unplaced,
    })),
    best: {
      fitness: best.fitness,
      utilisation: best.utilisation === null ? null : round(best.utilisation),
      sheets: best.sheets,
      placed: best.placed,
      unplaced: best.unplaced,
    },
    pairScan: {
      uniqueParts: pairN,
      legacyOnScan: { pairs: legacyPairs.pairs, ms: round(legacyPairs.ms) },
      engineBuildNfpPairs: enginePairs
        ? { pairs: enginePairs.pairs, ms: round(enginePairs.ms) }
        : null,
    },
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };

  const text = JSON.stringify(report, null, 2);
  if (outPath) fs.writeFileSync(outPath, text);
  process.stdout.write("\nBENCH_JSON " + JSON.stringify(report) + "\n");
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

main();
