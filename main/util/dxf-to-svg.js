/**
 * Offline DXF → SVG.
 *
 * Uses the MIT parser `dxf` (skymakerolof/dxf) for entities, blocks, and
 * inserts. Path data is written here so bulges stay arcs and cubic splines
 * stay beziers. Coordinates stay in DXF units. The import screen's
 * "DXF import units" scale is applied later, the same way it was applied to
 * the old converter's SVG. Y is flipped into SVG's downward axis so the
 * profile matches a CAD view.
 */
"use strict";

const dxf = require("dxf");
const toPiecewiseBezier = require("dxf/lib/util/toPiecewiseBezier.js").default;
const { multiplicity } = require("dxf/lib/util/toPiecewiseBezier.js");

const TAU = Math.PI * 2;

function fmt(value) {
  if (typeof value !== "number" || !isFinite(value)) return "0";
  const rounded = Math.round(value * 1e6) / 1e6;
  if (Object.is(rounded, -0)) return "0";
  return String(rounded);
}

function decode(input) {
  const raw = Buffer.isBuffer(input)
    ? input.toString(input.toString("utf8").indexOf("SECTION") !== -1 ? "utf8" : "latin1")
    : String(input || "");
  return raw
    .split(/\r\n|\r|\n/)
    .map(function (line) { return line.trim(); })
    .filter(function (line) { return line.length > 0; })
    .join("\n");
}

function expandBounds(bounds, point) {
  if (!point || !isFinite(point.x) || !isFinite(point.y)) return;
  if (point.x < bounds.minX) bounds.minX = point.x;
  if (point.y < bounds.minY) bounds.minY = point.y;
  if (point.x > bounds.maxX) bounds.maxX = point.x;
  if (point.y > bounds.maxY) bounds.maxY = point.y;
}

function entityMatrices(entity) {
  const list = [];
  if (entity && entity.extrusionZ === -1) {
    list.push([-1, 0, 0, 1, 0, 0]);
  }
  (entity && entity.transforms ? entity.transforms : []).forEach(function (transform) {
    const tx = transform.x || 0;
    const ty = transform.y || 0;
    const sx = transform.scaleX || 1;
    const sy = transform.scaleY || 1;
    const angle = ((transform.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let a;
    let b;
    let c;
    let d;
    if (transform.extrusionZ === -1) {
      a = -sx * cos;
      b = sx * sin;
      c = sy * sin;
      d = sy * cos;
    } else {
      a = sx * cos;
      b = sx * sin;
      c = -sy * sin;
      d = sy * cos;
    }
    list.push([a, b, c, d, tx, ty]);
  });
  return list;
}

function mapDxf(point, mats) {
  let x = Number(point.x) || 0;
  let y = Number(point.y) || 0;
  for (let i = 0; i < mats.length; i++) {
    const m = mats[i];
    const nx = m[0] * x + m[2] * y + m[4];
    const ny = m[1] * x + m[3] * y + m[5];
    x = nx;
    y = ny;
  }
  return { x: x, y: y };
}

function mapPoint(point, mats) {
  const mapped = mapDxf(point, mats);
  return { x: mapped.x, y: -mapped.y };
}

function circleFrom3(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  return {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
}

function signedSweep(center, from, to, via) {
  const a0 = Math.atan2(from.y - center.y, from.x - center.x);
  const a1 = Math.atan2(to.y - center.y, to.x - center.x);
  const av = Math.atan2(via.y - center.y, via.x - center.x);
  let sweep = a1 - a0;
  if (sweep < 0) sweep += TAU;
  const viaCCW = (av - a0 + TAU) % TAU;
  if (viaCCW > sweep + 1e-4) sweep -= TAU;
  return sweep;
}

function arcCommand(start, via, end, commands) {
  const center = circleFrom3(start, via, end);
  if (!center) {
    commands.line += 1;
    return "L " + fmt(end.x) + " " + fmt(end.y);
  }
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  if (!(radius > 1e-9)) {
    commands.line += 1;
    return "L " + fmt(end.x) + " " + fmt(end.y);
  }
  const sweep = signedSweep(center, start, end, via);
  const large = Math.abs(sweep) > Math.PI + 1e-6 ? 1 : 0;
  const sweepFlag = sweep > 0 ? 1 : 0;
  commands.arc += 1;
  return (
    "A " +
    fmt(radius) +
    " " +
    fmt(radius) +
    " 0 " +
    large +
    " " +
    sweepFlag +
    " " +
    fmt(end.x) +
    " " +
    fmt(end.y)
  );
}

function pointOnBulge(from, to, bulge, t) {
  const theta = 4 * Math.atan(bulge);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chord = Math.hypot(dx, dy);
  const radius = Math.abs(chord / (2 * Math.sin(theta / 2)));
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) * (chord / 2)));
  const nx = -dy / chord;
  const ny = dx / chord;
  const side = Math.abs(theta) <= Math.PI ? 1 : -1;
  const sign = theta >= 0 ? 1 : -1;
  const cx = mx + side * sign * h * nx;
  const cy = my + side * sign * h * ny;
  const a0 = Math.atan2(from.y - cy, from.x - cx);
  const angle = a0 + theta * t;
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

function addMove(parts, point, commands) {
  parts.push("M " + fmt(point.x) + " " + fmt(point.y));
  commands.move += 1;
}

function polylinePath(vertices, closed, mats, bounds, commands) {
  if (!vertices || vertices.length < 2) return "";
  const parts = [];
  const first = mapPoint(vertices[0], mats);
  expandBounds(bounds, mapDxf(vertices[0], mats));
  addMove(parts, first, commands);
  const segments = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < segments; i++) {
    const from = vertices[i];
    const to = vertices[(i + 1) % vertices.length];
    expandBounds(bounds, mapDxf(to, mats));
    const bulge = Number(from.bulge) || 0;
    const end = mapPoint(to, mats);
    if (Math.abs(bulge) < 1e-9 || Math.hypot(to.x - from.x, to.y - from.y) < 1e-9) {
      parts.push("L " + fmt(end.x) + " " + fmt(end.y));
      commands.line += 1;
      continue;
    }
    const via = mapPoint(pointOnBulge(from, to, bulge, 0.5), mats);
    expandBounds(bounds, mapDxf(pointOnBulge(from, to, bulge, 0.5), mats));
    parts.push(arcCommand(mapPoint(from, mats), via, end, commands));
  }
  if (closed) {
    parts.push("Z");
    commands.close += 1;
  }
  return parts.join(" ");
}

function circlePath(cx, cy, radius, mats, bounds, commands) {
  const at = function (angle) {
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  };
  [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].forEach(function (angle) {
    expandBounds(bounds, mapDxf(at(angle), mats));
  });
  const p0 = mapPoint(at(0), mats);
  const p1 = mapPoint(at(Math.PI / 2), mats);
  const p2 = mapPoint(at(Math.PI), mats);
  const p3 = mapPoint(at((3 * Math.PI) / 2), mats);
  const p4 = mapPoint(at(TAU), mats);
  const parts = ["M " + fmt(p0.x) + " " + fmt(p0.y)];
  commands.move += 1;
  parts.push(arcCommand(p0, p1, p2, commands));
  parts.push(arcCommand(p2, p3, p4, commands));
  parts.push("Z");
  commands.close += 1;
  return parts.join(" ");
}

function arcPath(entity, mats, bounds, commands) {
  let start = Number(entity.startAngle) || 0;
  let end = Number(entity.endAngle) || 0;
  while (end <= start) end += TAU;
  if (end - start > TAU - 1e-4) {
    return circlePath(entity.x, entity.y, entity.r, mats, bounds, commands);
  }
  const at = function (angle) {
    return {
      x: entity.x + entity.r * Math.cos(angle),
      y: entity.y + entity.r * Math.sin(angle),
    };
  };
  const a = at(start);
  const b = at((start + end) / 2);
  const c = at(end);
  expandBounds(bounds, mapDxf(a, mats));
  expandBounds(bounds, mapDxf(b, mats));
  expandBounds(bounds, mapDxf(c, mats));
  const parts = [];
  addMove(parts, mapPoint(a, mats), commands);
  parts.push(arcCommand(mapPoint(a, mats), mapPoint(b, mats), mapPoint(c, mats), commands));
  return parts.join(" ");
}

function ellipsePoint(entity, angle) {
  const major = Math.hypot(entity.majorX || 0, entity.majorY || 0);
  const ratio = Number(entity.axisRatio);
  const minor = major * (isFinite(ratio) && ratio > 0 ? ratio : 1);
  const rot = Math.atan2(entity.majorY || 0, entity.majorX || 0);
  const lx = major * Math.cos(angle);
  const ly = minor * Math.sin(angle);
  return {
    x: (entity.x || 0) + lx * Math.cos(rot) - ly * Math.sin(rot),
    y: (entity.y || 0) + lx * Math.sin(rot) + ly * Math.cos(rot),
  };
}

function ellipseAxes(entity, mats) {
  const major = Math.hypot(entity.majorX || 0, entity.majorY || 0);
  const ratio = Number(entity.axisRatio);
  const minorLen = major * (isFinite(ratio) && ratio > 0 ? ratio : 1);
  const rot = Math.atan2(entity.majorY || 0, entity.majorX || 0);
  const majorEnd = mapPoint(
    {
      x: (entity.x || 0) + major * Math.cos(rot),
      y: (entity.y || 0) + major * Math.sin(rot),
    },
    mats,
  );
  const minorEnd = mapPoint(
    {
      x: (entity.x || 0) + minorLen * -Math.sin(rot),
      y: (entity.y || 0) + minorLen * Math.cos(rot),
    },
    mats,
  );
  const center = mapPoint({ x: entity.x || 0, y: entity.y || 0 }, mats);
  return {
    center: center,
    rx: Math.hypot(majorEnd.x - center.x, majorEnd.y - center.y),
    ry: Math.hypot(minorEnd.x - center.x, minorEnd.y - center.y),
    rotation: (Math.atan2(majorEnd.y - center.y, majorEnd.x - center.x) * 180) / Math.PI,
  };
}

function ellipsePath(entity, mats, bounds, commands) {
  let start = Number(entity.startAngle) || 0;
  let end = entity.endAngle == null ? TAU : Number(entity.endAngle);
  while (end < start) end += TAU;
  let span = end - start;
  if (span < 1e-6 || Math.abs(span - TAU) < 1e-4) {
    start = 0;
    end = TAU;
    span = TAU;
  }
  const axes = ellipseAxes(entity, mats);
  const steps = span > Math.PI + 1e-6 ? 2 : 1;
  const parts = [];
  const first = mapPoint(ellipsePoint(entity, start), mats);
  addMove(parts, first, commands);
  for (let i = 0; i < steps; i++) {
    const a0 = start + (span * i) / steps;
    const a1 = start + (span * (i + 1)) / steps;
    const mid = ellipsePoint(entity, (a0 + a1) / 2);
    const dest = ellipsePoint(entity, a1);
    expandBounds(bounds, mapDxf(ellipsePoint(entity, a0), mats));
    expandBounds(bounds, mapDxf(mid, mats));
    expandBounds(bounds, mapDxf(dest, mats));
    const sweep = signedSweep(
      axes.center,
      mapPoint(ellipsePoint(entity, a0), mats),
      mapPoint(dest, mats),
      mapPoint(mid, mats),
    );
    // Elliptical arcs are not circular, so the sweep sign still tells the
    // direction and a half-or-less step keeps the large-arc flag at 0.
    parts.push(
      "A " +
        fmt(axes.rx) +
        " " +
        fmt(axes.ry) +
        " " +
        fmt(axes.rotation) +
        " 0 " +
        (sweep >= 0 ? 1 : 0) +
        " " +
        fmt(mapPoint(dest, mats).x) +
        " " +
        fmt(mapPoint(dest, mats).y),
    );
    commands.arc += 1;
  }
  if (Math.abs(span - TAU) < 1e-4) {
    parts.push("Z");
    commands.close += 1;
  }
  return parts.join(" ");
}

function splinePath(entity, mats, bounds, commands) {
  const degree = Number(entity.degree);
  const controls = entity.controlPoints || [];
  const knots = entity.knots || [];
  const weighted = entity.weights && entity.weights.some(function (weight) { return weight !== 1; });
  if ((degree === 2 || degree === 3) && !weighted && controls.length > degree && knots.length) {
    try {
      const order = degree + 1;
      const piece = toPiecewiseBezier(order, controls, knots);
      return piecewisePath(order, piece, mats, bounds, commands, !!entity.closed);
    } catch (err) {
      void err;
    }
  }
  if (controls.length >= 2) {
    return polylinePath(controls, !!entity.closed, mats, bounds, commands);
  }
  return "";
}

function piecewisePath(order, piece, mats, bounds, commands, closed) {
  const knots = piece.knots;
  const controls = piece.controlPoints;
  const parts = [];
  let controlIndex = 0;
  let knotIndex = order;
  let started = false;
  while (knotIndex < knots.length - order + 1) {
    const span = multiplicity(knots, knotIndex);
    const cp = controls.slice(controlIndex, controlIndex + order);
    if (cp.length < order) break;
    cp.forEach(function (point) {
      expandBounds(bounds, mapDxf(point, mats));
    });
    const mapped = cp.map(function (point) {
      return mapPoint(point, mats);
    });
    if (!started) {
      addMove(parts, mapped[0], commands);
      started = true;
    }
    if (order === 4) {
      parts.push(
        "C " +
          fmt(mapped[1].x) +
          " " +
          fmt(mapped[1].y) +
          " " +
          fmt(mapped[2].x) +
          " " +
          fmt(mapped[2].y) +
          " " +
          fmt(mapped[3].x) +
          " " +
          fmt(mapped[3].y),
      );
      commands.cubic += 1;
    } else if (order === 3) {
      parts.push(
        "Q " + fmt(mapped[1].x) + " " + fmt(mapped[1].y) + " " + fmt(mapped[2].x) + " " + fmt(mapped[2].y),
      );
      commands.quadratic += 1;
    }
    controlIndex += span;
    knotIndex += span;
  }
  if (closed && started) {
    parts.push("Z");
    commands.close += 1;
  }
  return parts.join(" ");
}

function entityPath(entity, bounds, commands) {
  const mats = entityMatrices(entity);
  switch (entity.type) {
    case "LINE":
      return polylinePath(
        [
          { x: entity.start.x, y: entity.start.y },
          { x: entity.end.x, y: entity.end.y },
        ],
        false,
        mats,
        bounds,
        commands,
      );
    case "LWPOLYLINE":
    case "POLYLINE":
      return polylinePath(entity.vertices, !!entity.closed, mats, bounds, commands);
    case "CIRCLE":
      return circlePath(entity.x, entity.y, entity.r, mats, bounds, commands);
    case "ARC":
      return arcPath(entity, mats, bounds, commands);
    case "ELLIPSE":
      return ellipsePath(entity, mats, bounds, commands);
    case "SPLINE":
      return splinePath(entity, mats, bounds, commands);
    default:
      return "";
  }
}

function convertDxf(input, options) {
  const text = decode(input);
  const fallbackUnit = options && options.units === "mm" ? "mm" : "in";
  if (text.indexOf("SECTION") === -1) {
    throw new Error("This file is not a DXF drawing");
  }
  let parsed;
  try {
    parsed = dxf.parseString(text);
  } catch (err) {
    throw new Error("Could not read this DXF (" + (err && err.message ? err.message : "parse error") + ")");
  }
  const entities = dxf.denormalise(parsed);
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const commands = { move: 0, line: 0, arc: 0, cubic: 0, quadratic: 0, close: 0 };
  const unsupported = [];
  const paths = [];
  (entities || []).forEach(function (entity) {
    if (!entity || !entity.type) return;
    const d = entityPath(entity, bounds, commands);
    if (d) {
      paths.push('<path d="' + d + '" fill="none" stroke="#000"/>');
      return;
    }
    if (unsupported.indexOf(entity.type) === -1) unsupported.push(entity.type);
  });
  if (!paths.length) {
    throw new Error(
      unsupported.length
        ? "No supported geometry in this DXF (" + unsupported.join(", ") + ")"
        : "No supported geometry in this DXF",
    );
  }
  const finite = isFinite(bounds.minX);
  const insunits = parsed.header ? parsed.header.insUnits : undefined;
  const svg = svgDocument(paths, finite ? bounds : { minX: 0, minY: 0, maxX: 0, maxY: 0 }, insunits, fallbackUnit);
  return {
    svg: svg,
    insunits: insunits,
    bounds: finite
      ? bounds
      : { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    commands: commands,
    unsupported: unsupported,
  };
}

function dxfToSvg(input, options) {
  return convertDxf(input, options).svg;
}

// Inches per one DXF unit, for $INSUNITS values svgparser cannot name directly.
// 1 inch, 2 feet, 4 mm, 5 cm, 6 m are the ones shop files use.
var INCHES_PER_UNIT = {
  1: 1,
  2: 12,
  3: 63360,
  4: 1 / 25.4,
  5: 1 / 2.54,
  6: 1000 / 25.4,
  7: 1000000 / 25.4,
  8: 1e-6,
  9: 0.001,
  10: 36,
  11: 1e-10 / 0.0254,
  12: 1e-9 / 0.0254,
  13: 1e-6 / 0.0254,
  14: 0.1 / 0.0254,
  15: 10 / 0.0254,
  16: 100 / 0.0254,
  17: 1000 / 0.0254,
};

// svgparser understands in, mm, and cm. For those, the width number matches the
// viewBox (DXF units). Other units are written in inches so the ratio is right.
function sizeSpec(insunits, fallbackUnit) {
  var code = Number(insunits);
  if (code === 1) return { suffix: "in", native: true };
  if (code === 4) return { suffix: "mm", native: true };
  if (code === 5) return { suffix: "cm", native: true };
  if (!(code > 0) || !INCHES_PER_UNIT[code]) {
    return fallbackUnit === "mm" ? { suffix: "mm", native: true } : { suffix: "in", native: true };
  }
  return { suffix: "in", native: false, inchesPerUnit: INCHES_PER_UNIT[code] };
}

function svgDocument(paths, bounds, insunits, fallbackUnit) {
  var minX = isFinite(bounds.minX) ? bounds.minX : 0;
  var minY = isFinite(bounds.minY) ? bounds.minY : 0;
  var maxX = isFinite(bounds.maxX) ? bounds.maxX : 0;
  var maxY = isFinite(bounds.maxY) ? bounds.maxY : 0;
  var spanX = maxX - minX;
  var spanY = maxY - minY;
  if (!(spanX > 0)) spanX = 1e-6;
  if (!(spanY > 0)) spanY = 1e-6;
  var spec = sizeSpec(insunits, fallbackUnit);
  var widthNum = spec.native ? spanX : spanX * spec.inchesPerUnit;
  var heightNum = spec.native ? spanY : spanY * spec.inchesPerUnit;
  // Path Y is already flipped. The viewBox uses those coordinates; its width
  // stays the DXF span so svgparser's unit ratio is unchanged.
  var viewBox = [fmt(minX), fmt(-maxY), fmt(spanX), fmt(spanY)].join(" ");
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    fmt(widthNum) +
    spec.suffix +
    '" height="' +
    fmt(heightNum) +
    spec.suffix +
    '" viewBox="' +
    viewBox +
    '">' +
    paths.join("") +
    "</svg>"
  );
}

module.exports = {
  convertDxf: convertDxf,
  dxfToSvg: dxfToSvg,
};
