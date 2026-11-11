#!/usr/bin/env node
/**
 * How many knife blanks fit on a 10" x 48" sheet.
 *
 * The shapes are stand-ins (elongated blanks), not a customer's DXF.
 * The sheet is 48 long by 10 wide, in the same units the polygons use.
 * Max-out even distribution only accepts equal counts. Part count of 9
 * (3 of each) is placed with gravity so the leftover length can be measured.
 *
 *   node scripts/knife-sets.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Distribution = require("../main/util/distribution.js");

const root = path.resolve(__dirname, "..");

const SHEET_LENGTH = 48;
const SHEET_WIDTH = 10;

const BLANKS = {
  chef: [
    [0, 0.25],
    [3, 0.25],
    [8, 0.05],
    [12, 0.7],
    [8, 1.4],
    [3, 1.45],
    [3, 1.85],
    [0, 1.85],
  ],
  utility: [
    [0, 0.2],
    [2.2, 0.15],
    [6.2, 0],
    [8, 0.45],
    [6.2, 0.95],
    [2.2, 1.05],
    [2.2, 1.25],
    [0, 1.25],
  ],
  paring: [
    [0, 0.15],
    [1.8, 0.1],
    [5, 0],
    [6.4, 0.35],
    [5, 0.7],
    [1.8, 0.8],
    [1.8, 0.95],
    [0, 0.95],
  ],
};

function boundsOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  points.forEach(([x, y]) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });
  return { width: maxX - minX, height: maxY - minY, area: (maxX - minX) * (maxY - minY) };
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
    navigator: { userAgent: "chrome", appName: "Netscape", hardwareConcurrency: 4 },
    ipcRenderer: { send() {} },
    addon: {
      calculateNFP() {
        throw new Error("native NFP addon was invoked");
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
    { filename: "knife-stubs.js" },
  );

  const background = fs
    .readFileSync(path.join(root, "main/background.js"), "utf8")
    .replace(/^import .*;\s*$/gm, "");
  vm.runInContext(background, context, { filename: path.join(root, "main/background.js") });
  context.window.db = new context.NfpCache();
  return context;
}

function polygon(points, source, id, rotation) {
  const poly = points.map(([x, y]) => ({ x, y }));
  poly.source = source;
  poly.id = id;
  poly.rotation = rotation || 0;
  return poly;
}

function sheetPolygon() {
  return polygon(
    [
      [0, 0],
      [SHEET_LENGTH, 0],
      [SHEET_LENGTH, SHEET_WIDTH],
      [0, SHEET_WIDTH],
    ],
    0,
    "sheet",
    0,
  );
}

function placedCount(result) {
  if (!result || !result.placements) return 0;
  return result.placements.reduce((sum, sheet) => sum + sheet.sheetplacements.length, 0);
}

function usedBounds(result, shapes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  (result.placements || []).forEach((sheet) => {
    sheet.sheetplacements.forEach((placement) => {
      const points = shapes[placement.source];
      if (!points) return;
      const rad = ((placement.rotation || 0) * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      points.forEach(([x, y]) => {
        const rx = x * c - y * s + placement.x;
        const ry = x * s + y * c + placement.y;
        if (rx < minX) minX = rx;
        if (ry < minY) minY = ry;
        if (rx > maxX) maxX = rx;
        if (ry > maxY) maxY = ry;
      });
    });
  });
  if (!isFinite(minX)) return null;
  return {
    minX: round(minX),
    minY: round(minY),
    width: round(maxX - minX),
    height: round(maxY - minY),
    leftoverLength: round(SHEET_LENGTH - (maxX - minX)),
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function main() {
  const context = loadEngine();
  const names = Object.keys(BLANKS);
  const shapes = {};
  const items = [
    {
      sheet: true,
      filename: "10x48 sheet",
      width: SHEET_LENGTH,
      height: SHEET_WIDTH,
      area: SHEET_LENGTH * SHEET_WIDTH,
      quantity: 1,
      percent: null,
    },
  ];
  names.forEach((name, offset) => {
    const points = BLANKS[name];
    const box = boundsOf(points);
    const index = offset + 1;
    shapes[index] = points;
    items.push({
      sheet: false,
      filename: name,
      width: box.width,
      height: box.height,
      area: box.area,
      quantity: 1,
      percent: null,
    });
  });

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

  function place(sequence, rotationByIndex, placementType) {
    const sheets = [sheetPolygon()];
    const parts = sequence.map((index, n) =>
      polygon(shapes[index], index, n, rotationByIndex[index] || 0),
    );
    context.sheets = sheets;
    context.parts = parts;
    context.cfg = Object.assign({}, cfg, { placementType: placementType });
    let result = null;
    try {
      result = vm.runInContext("placeParts(sheets, parts, cfg, 0)", context, {
        filename: "knife-call.js",
      });
    } catch (err) {
      return { ok: false, placed: 0, error: String(err && err.message ? err.message : err) };
    }
    const placed = placedCount(result);
    return {
      ok: placed === parts.length && parts.length > 0,
      placed,
      asked: parts.length,
      bounds: usedBounds(result, shapes),
      fitness: result && result.fitness,
      sheets: result && result.placements ? result.placements.length : 0,
    };
  }

  const reports = {};
  ["gravity", "box"].forEach((placementType) => {
    const started = process.hrtime.bigint();
    let checks = 0;
    const fit = Distribution.runMaxOut(
      { even: true, rotations: 4, items: items },
      function (sequence, rotationByIndex) {
        checks++;
        const attempt = place(sequence, rotationByIndex, placementType);
        return attempt.ok;
      },
    );
    const proof = fit.sequence.length
      ? place(fit.sequence, fit.rotationByIndex, placementType)
      : null;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    reports[placementType] = {
      sets: fit.level,
      perDesign: fit.level,
      totalParts: fit.totalParts,
      quantities: fit.quantities,
      order: fit.order,
      ceiling: fit.ceiling,
      areaGuess: fit.areaGuess,
      checks,
      ms: round(ms),
      proof: proof
        ? {
            placed: proof.placed,
            asked: proof.asked,
            allPlaced: proof.ok,
            bounds: proof.bounds,
            sheets: proof.sheets,
          }
        : null,
      hint: fit.hint,
    };
  });

  const counted = Distribution.planPartCount({
    even: true,
    total: 9,
    rotations: 4,
    items: items,
  });
  const countedPlace = place(counted.sequence, counted.rotationByIndex, "gravity");

  const report = {
    sheet: { length: SHEET_LENGTH, width: SHEET_WIDTH, note: "10 inch by 48 inch, length along X" },
    blanks: names.map((name) => Object.assign({ name }, boundsOf(BLANKS[name]))),
    maxOutEven: reports,
    partCountNine: {
      quantities: counted.quantities,
      hint: counted.hint,
      placed: countedPlace.placed,
      asked: countedPlace.asked,
      allPlaced: countedPlace.ok,
      bounds: countedPlace.bounds,
      placementType: "gravity",
    },
    node: process.version,
    platform: process.platform,
  };

  process.stdout.write("\nKNIFE_JSON " + JSON.stringify(report) + "\n");
}

main();
