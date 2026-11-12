"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const ExportGeometry = require("../main/util/export-geometry.js");

function quarterCircle(steps) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    points.push({ x: Math.cos(t), y: Math.sin(t) });
  }
  return points;
}

test("a real arc exports as one arc, rotated and translated", () => {
  const source = "M1 0 A1 1 0 0 1 0 1";
  const parsed = ExportGeometry.parsePath(source);
  assert.equal(ExportGeometry.segmentCount(parsed), 1);

  const placed = ExportGeometry.placePath(source, { x: 10, y: 5, rotation: 90 }, 0.01);
  assert.equal(placed.segments, 1);
  assert.match(placed.d, /A/);
  const end = ExportGeometry.rotateThenTranslate(0, 1, { x: 10, y: 5, rotation: 90 });
  assert.ok(Math.abs(end.x - 9) < 1e-9);
  assert.ok(Math.abs(end.y - 5) < 1e-9);
  assert.match(placed.d, /9 /);
});

test("a quadratic curve stays one quadratic, not a polyline", () => {
  const source = "M0 0 Q1 2 2 0";
  const placed = ExportGeometry.placePath(source, { x: 0, y: 0, rotation: 0 }, 0.001);
  assert.equal(placed.sourceSegments, 1);
  assert.equal(placed.segments, 1);
  assert.match(placed.d, /Q/);
  assert.equal(placed.d.indexOf("L"), -1);
});

test("a dense arc polyline collapses to one arc within tolerance", () => {
  const points = quarterCircle(40);
  const tolerance = 0.01;
  const placed = ExportGeometry.placePolyline(points, false, { x: 0, y: 0, rotation: 0 }, tolerance);
  assert.ok(placed.segments < 5, "expected a few commands, got " + placed.segments + " from " + points.length);
  assert.match(placed.d, /A/);
  const deviation = ExportGeometry.maxDeviation(points, placed.subpaths);
  assert.ok(deviation <= tolerance + 1e-6, "deviation " + deviation);
});

test("rectangle corners survive a small tolerance and stay closed", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 4 },
    { x: 0, y: 4 },
  ];
  const placed = ExportGeometry.placePolyline(points, true, { x: 0, y: 0, rotation: 0 }, 0.01);
  assert.equal(placed.subpaths[0].closed, true);
  assert.match(placed.d, /Z$/);
  assert.equal(placed.segments, 4);
  const deviation = ExportGeometry.maxDeviation(points, placed.subpaths);
  assert.ok(deviation <= 0.01);
});

test("a hole stays a second closed contour", () => {
  const d = "M0 0 L10 0 L10 10 L0 10 Z M3 3 L3 6 L6 6 L6 3 Z";
  const placed = ExportGeometry.placePath(d, { x: 0, y: 0, rotation: 0 }, 0.01);
  assert.equal(placed.subpaths.length, 2);
  assert.equal(placed.subpaths[0].closed, true);
  assert.equal(placed.subpaths[1].closed, true);
  assert.equal(placed.segments, 8);
});

test("zero tolerance does not drop polyline vertices", () => {
  const points = quarterCircle(20);
  const placed = ExportGeometry.placePolyline(points, false, { x: 0, y: 0, rotation: 0 }, 0);
  assert.equal(placed.segments, points.length - 1);
});

test("DXF uses arc bulges instead of one line per sample", () => {
  const points = quarterCircle(30);
  const placed = ExportGeometry.placePolyline(points, false, { x: 0, y: 0, rotation: 0 }, 0.01);
  const dxf = ExportGeometry.toDxf(placed.subpaths, 1);
  assert.match(dxf, /LWPOLYLINE/);
  assert.match(dxf, /\n42\n(?!0(?:\.0+)?\n)/);
  const vertices = dxf.split("\n").filter((line, index, all) => all[index - 1] === "10").length;
  assert.ok(vertices < 6, "dxf vertices " + vertices);
});

test("an L bracket keeps its six corners", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 1.2 },
    { x: 1.2, y: 1.2 },
    { x: 1.2, y: 3 },
    { x: 0, y: 3 },
  ];
  const placed = ExportGeometry.placePolyline(points, true, { x: 1, y: 2, rotation: 0 }, 0.005);
  assert.equal(placed.segments, 6);
  assert.equal(placed.subpaths[0].closed, true);
});
