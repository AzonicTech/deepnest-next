#!/usr/bin/env node
/**
 * Point counts for a curved knife blank and the bench polygons.
 *
 * "Before" is the nesting linearization (what a polygon export would cut).
 * "After" is the cut-file geometry: original curves stay curves, and a
 * line-only approximation is simplified and re-fit to arcs.
 *
 *   node scripts/export-points.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ExportGeometry = require("../main/util/export-geometry.js");

const root = path.resolve(__dirname, "..");

function loadGeometryUtil() {
  const context = { console, Math, Array, Object, Number, String, isNaN, isFinite };
  context.window = context;
  context.global = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "main/util/geometryutil.js"), "utf8"), context, {
    filename: "geometryutil.js",
  });
  return context.GeometryUtil;
}

// A knife-blank outline in inches: two straight edges and two real arcs.
const KNIFE_D =
  "M0 0.4 L8 0.15 A3 1.2 0 0 1 11.6 0.85 A2.2 0.8 0 0 1 8 1.55 L0 1.7 Z";

function linearizePath(GeometryUtil, d, tolerance) {
  const subpaths = ExportGeometry.parsePath(d);
  let points = 0;
  subpaths.forEach((sub) => {
    let cursor = sub.commands[0];
    for (let i = 1; i < sub.commands.length; i++) {
      const command = sub.commands[i];
      if (command.type === "A") {
        const samples = GeometryUtil.Arc.linearize(
          { x: cursor.x, y: cursor.y },
          { x: command.x, y: command.y },
          command.rx,
          command.ry,
          command.angle,
          command.large,
          command.sweep,
          tolerance,
        );
        points += samples.length;
      } else if (command.type === "L") {
        points += 1;
      } else {
        points += 1;
      }
      cursor = command;
    }
  });
  return points;
}

function denseArcPolyline(steps) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    points.push({ x: 2 * Math.cos(t), y: 2 * Math.sin(t) });
  }
  return points;
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

function main() {
  const GeometryUtil = loadGeometryUtil();
  const knife = ExportGeometry.placePath(KNIFE_D, { x: 0, y: 0, rotation: 0 }, 0.005);
  const beforeFine = linearizePath(GeometryUtil, KNIFE_D, 0.001);
  const beforeShop = linearizePath(GeometryUtil, KNIFE_D, 0.01);

  const dense = denseArcPolyline(80);
  const refit = ExportGeometry.placePolyline(dense, false, { x: 0, y: 0, rotation: 0 }, 0.01);
  const deviation = ExportGeometry.maxDeviation(dense, refit.subpaths);

  const bench = [
    {
      name: "panel 140x80",
      points: [
        { x: 0, y: 0 },
        { x: 140, y: 0 },
        { x: 140, y: 80 },
        { x: 0, y: 80 },
      ],
    },
    {
      name: "bracket L",
      points: [
        { x: 0, y: 0 },
        { x: 90, y: 0 },
        { x: 90, y: 28 },
        { x: 28, y: 28 },
        { x: 28, y: 70 },
        { x: 0, y: 70 },
      ],
    },
  ].map((part) => {
    const placed = ExportGeometry.placePolyline(part.points, true, { x: 0, y: 0, rotation: 0 }, 0.36);
    return {
      name: part.name,
      sourceVertices: part.points.length,
      exportedSegments: placed.segments,
      closed: placed.subpaths[0].closed,
      maxDeviation: round(ExportGeometry.maxDeviation(part.points, placed.subpaths)),
    };
  });

  const report = {
    knife: {
      source: KNIFE_D,
      sourceSegments: knife.sourceSegments,
      exportedSegments: knife.segments,
      exportedPath: knife.d,
      linearizedAt001: beforeFine,
      linearizedAt01: beforeShop,
    },
    denseQuarterCircle: {
      sourcePoints: dense.length,
      exportedSegments: refit.segments,
      maxDeviation: round(deviation),
      tolerance: 0.01,
      path: refit.d,
    },
    bench: bench,
    node: process.version,
  };

  process.stdout.write("\nEXPORT_JSON " + JSON.stringify(report) + "\n");
}

main();
