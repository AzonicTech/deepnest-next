"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { convertDxf } = require("../main/util/dxf-to-svg.js");
const { readableConversionError } = require("../main/util/conversion-error.js");
const ExportGeometry = require("../main/util/export-geometry.js");

function dxf(parts) {
  return parts.filter(function (part) { return part; }).join("\n") + "\n";
}

function header(insunits) {
  return dxf(["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", String(insunits), "0", "ENDSEC"]);
}

function entities(body) {
  return dxf(["0", "SECTION", "2", "ENTITIES", body, "0", "ENDSEC", "0", "EOF"]);
}

function drawing(body, insunits, blocks) {
  return header(insunits == null ? 1 : insunits) + (blocks || "") + entities(body);
}

function pathData(svg) {
  return [...svg.matchAll(/d="([^"]+)"/g)].map(function (match) { return match[1]; });
}

function roughly(actual, expected, epsilon) {
  assert.ok(Math.abs(actual - expected) <= (epsilon || 1e-3), actual + " !~ " + expected);
}

test("a line keeps DXF units and flips Y into SVG", () => {
  const converted = convertDxf(drawing(dxf([
    "0", "LINE", "8", "0",
    "10", "0", "20", "1",
    "11", "10", "21", "4",
  ]), 1));
  assert.equal(converted.insunits, 1);
  roughly(converted.bounds.maxX - converted.bounds.minX, 10);
  roughly(converted.bounds.maxY - converted.bounds.minY, 3);
  const d = pathData(converted.svg)[0];
  assert.match(d, /^M 0 -1 L 10 -4$/);
  assert.equal(converted.commands.arc, 0);
  assert.equal(converted.commands.line, 1);
});

test("an arc and a circle stay arcs, and a circle is closed", () => {
  const arc = convertDxf(drawing(dxf([
    "0", "ARC", "8", "0",
    "10", "0", "20", "0", "40", "10",
    "50", "0", "51", "90",
  ])));
  assert.equal(arc.commands.arc, 1);
  assert.equal(arc.commands.line, 0);
  const arcD = pathData(arc.svg)[0];
  assert.match(arcD, /A 10 10 0 0/);
  assert.match(arcD, /0 -10/);
  assert.match(arcD, /-10 0|0 -10/);

  const circle = convertDxf(drawing(dxf([
    "0", "CIRCLE", "8", "0",
    "10", "2", "20", "3", "40", "5",
  ])));
  assert.equal(circle.commands.arc, 2);
  assert.equal(circle.commands.close, 1);
  assert.equal(circle.commands.line, 0);
  roughly(circle.bounds.maxX - circle.bounds.minX, 10);
  roughly(circle.bounds.maxY - circle.bounds.minY, 10);
});

test("a bulged polyline becomes one arc, and a closed outline stays closed", () => {
  const bulge = convertDxf(drawing(dxf([
    "0", "LWPOLYLINE", "8", "0", "90", "2", "70", "0",
    "10", "0", "20", "0", "42", "1",
    "10", "10", "20", "0",
  ])));
  assert.equal(bulge.commands.arc, 1);
  assert.equal(bulge.commands.line, 0);
  roughly(bulge.bounds.minY, -5);
  roughly(bulge.bounds.maxY, 0);

  const classic = convertDxf(drawing(dxf([
    "0", "POLYLINE", "8", "0", "70", "1",
    "0", "VERTEX", "10", "0", "20", "0", "42", "0",
    "0", "VERTEX", "10", "4", "20", "0", "42", "0",
    "0", "VERTEX", "10", "4", "20", "2", "42", "0",
    "0", "VERTEX", "10", "0", "20", "2", "42", "0",
    "0", "SEQEND",
  ])));
  assert.equal(classic.commands.close, 1);
  assert.equal(classic.commands.line, 4);
  assert.equal(classic.commands.arc, 0);
  roughly(classic.bounds.maxX - classic.bounds.minX, 4);
  roughly(classic.bounds.maxY - classic.bounds.minY, 2);
});

test("a full ellipse and a cubic spline stay curves", () => {
  const ellipse = convertDxf(drawing(dxf([
    "0", "ELLIPSE", "8", "0",
    "10", "0", "20", "0",
    "11", "6", "21", "0",
    "40", "0.5",
    "41", "0", "42", String(Math.PI * 2),
  ])));
  assert.equal(ellipse.commands.arc, 2);
  assert.equal(ellipse.commands.close, 1);
  roughly(ellipse.bounds.maxX - ellipse.bounds.minX, 12);
  roughly(ellipse.bounds.maxY - ellipse.bounds.minY, 6);

  const spline = convertDxf(drawing(dxf([
    "0", "SPLINE", "8", "0",
    "70", "8", "71", "3", "72", "8", "73", "4",
    "40", "0", "40", "0", "40", "0", "40", "0",
    "40", "1", "40", "1", "40", "1", "40", "1",
    "10", "0", "20", "0",
    "10", "1", "20", "2",
    "10", "2", "20", "2",
    "10", "3", "20", "0",
  ])));
  assert.equal(spline.commands.cubic, 1);
  assert.equal(spline.commands.line, 0);
  assert.match(pathData(spline.svg)[0], /C /);
  roughly(spline.bounds.maxX - spline.bounds.minX, 3);
});

test("an insert places the block geometry at the insert point", () => {
  const blocks = dxf([
    "0", "SECTION", "2", "BLOCKS",
    "0", "BLOCK", "2", "TIP", "10", "0", "20", "0",
    "0", "LINE", "8", "0", "10", "0", "20", "0", "11", "5", "21", "1",
    "0", "ENDBLK",
    "0", "ENDSEC",
  ]);
  const converted = convertDxf(drawing(dxf([
    "0", "INSERT", "8", "0", "2", "TIP", "10", "100", "20", "20",
  ]), 1, blocks));
  roughly(converted.bounds.minX, 100);
  roughly(converted.bounds.minY, 20);
  roughly(converted.bounds.maxX, 105);
  roughly(converted.bounds.maxY, 21);
  assert.match(pathData(converted.svg)[0], /M 100 -20 L 105 -21/);
});

test("inch and millimetre drawings keep their own units for the import scale", () => {
  const inch = convertDxf(drawing(dxf([
    "0", "LINE", "8", "0", "10", "0", "20", "0", "11", "10", "21", "0",
  ]), 1));
  const mm = convertDxf(drawing(dxf([
    "0", "LINE", "8", "0", "10", "0", "20", "0", "11", "254", "21", "0",
  ]), 4));
  assert.equal(inch.insunits, 1);
  assert.equal(mm.insunits, 4);
  roughly(inch.bounds.maxX, 10);
  roughly(mm.bounds.maxX, 254);
  const inchScale = 72;
  const mmScale = 72 / 25.4;
  roughly(10 * inchScale, 254 * mmScale, 0.05);
});

test("a knife-blank DXF imports, places on a sheet, and exports with the same curve count", () => {
  const knife = drawing(dxf([
    "0", "LWPOLYLINE", "8", "0", "90", "4", "70", "1",
    "10", "0", "20", "0.4", "42", "0",
    "10", "11", "20", "0", "42", "0.45",
    "10", "12", "20", "1", "42", "0",
    "10", "0", "20", "1.6", "42", "-0.35",
  ]), 1);
  const imported = convertDxf(knife);
  assert.equal(imported.commands.arc, 2);
  assert.equal(imported.commands.line, 2);
  assert.equal(imported.commands.close, 1);
  roughly(imported.bounds.maxX - imported.bounds.minX, 12, 0.05);
  assert.ok(imported.bounds.maxY - imported.bounds.minY < 3);

  const placed = ExportGeometry.placePath(pathData(imported.svg)[0], { x: 1, y: 2, rotation: 0 }, 0.36);
  assert.equal(placed.segments, imported.commands.line + imported.commands.arc);
  const exported = ExportGeometry.toDxf(placed.subpaths, 1, "inch");
  const again = convertDxf(exported);
  assert.ok(again.commands.arc + again.commands.line <= imported.commands.arc + imported.commands.line + 1);
  roughly(again.bounds.maxX - again.bounds.minX, imported.bounds.maxX - imported.bounds.minX, 0.05);

  const outline = ExportGeometry.pathSamples(ExportGeometry.parsePath(pathData(imported.svg)[0]), 4);
  const xs = outline.map(function (point) { return point.x; });
  const ys = outline.map(function (point) { return -point.y; });
  const minX = Math.min.apply(null, xs);
  const minY = Math.min.apply(null, ys);
  const poly = outline.map(function (point) {
    return { x: point.x - minX, y: -point.y - minY };
  });
  poly.source = 1;
  poly.id = "knife";
  poly.rotation = 0;
  const sheet = [
    { x: 0, y: 0 },
    { x: 48, y: 0 },
    { x: 48, y: 10 },
    { x: 0, y: 10 },
  ];
  sheet.source = 0;
  sheet.id = "sheet";
  sheet.rotation = 0;
  const engine = loadEngine();
  const result = engine.placeParts([sheet], [poly], {
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
  }, 0);
  const placedCount = result.placements.reduce(function (sum, sheetPlace) {
    return sum + sheetPlace.sheetplacements.length;
  }, 0);
  assert.equal(placedCount, 1, JSON.stringify({
    placed: placedCount,
    fitness: result.fitness,
    points: poly.length,
    width: Math.max.apply(null, poly.map(function (point) { return point.x; })),
    height: Math.max.apply(null, poly.map(function (point) { return point.y; })),
  }));
});

test("a conversion failure reports the status, not the uploaded bytes", () => {
  const body = Array.from({ length: 400 }, function (_, index) { return index % 255; });
  const err = {
    message: "Request failed with status code 523",
    config: { data: body.join(",") },
    request: { body: body },
    response: { status: 523, data: "<html>cloudflare</html>" },
  };
  const text = readableConversionError(err);
  assert.match(text, /HTTP 523/);
  assert.equal(text.indexOf(body.slice(0, 12).join(",")), -1);
  assert.ok(text.length < 180);

  const dumped = readableConversionError({ message: "socket hang up", config: { data: body.join(",") } });
  assert.match(dumped, /socket hang up/);
  assert.equal(dumped.indexOf("100,101,102"), -1);
});

function loadEngine() {
  const root = path.resolve(__dirname, "..");
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
    addon: { calculateNFP() { throw new Error("native NFP addon was invoked"); } },
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
  return doc.A + "-" + doc.B + "-" + doc.Arotation + "-" + doc.Brotation;
};
NfpCache.prototype.has = function () { return false; };
NfpCache.prototype.find = function () { return null; };
NfpCache.prototype.insert = function () {};
NfpCache.prototype.getStats = function () { return 0; };
function HullPolygon() {}
HullPolygon.hull = function () { return null; };
`,
    context,
  );
  const background = fs.readFileSync(path.join(root, "main/background.js"), "utf8").replace(/^import .*;\s*$/gm, "");
  vm.runInContext(background, context, { filename: "background.js" });
  context.window.db = new context.NfpCache();
  return context;
}
