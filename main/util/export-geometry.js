/**
 * Lean cut-file geometry.
 *
 * Nesting linearizes curves so it can compute no-fit polygons. The cut file
 * should not use that approximation. Paths that already contain real curves
 * are exported with the placement rotate-then-translate baked into the
 * commands. Line-only paths are simplified and, where a run lies on a
 * circular arc, replaced with one arc. No original point is left more than
 * `tolerance` away from the exported geometry. Closed contours stay closed.
 *
 * Coordinates are in the same units as the part (SVG user units).
 */
"use strict";

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ExportGeometry = api;
  }
})(typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : this, function () {
  var TAU = Math.PI * 2;

  function num(value) {
    var n = Number(value);
    return typeof n === "number" && isFinite(n) ? n : 0;
  }

  function fmt(n) {
    var rounded = Math.round(n * 1e6) / 1e6;
    if (Object.is(rounded, -0)) rounded = 0;
    return String(rounded);
  }

  function tokenize(d) {
    var re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
    var tokens = [];
    var match;
    while ((match = re.exec(d))) {
      tokens.push(match[1] ? match[1] : match[2]);
    }
    return tokens;
  }

  function isCommand(token) {
    return typeof token === "string" && /[MmLlHhVvCcSsQqTtAaZz]/.test(token);
  }

  /**
   * Parse an SVG path into absolute subpaths.
   * Each subpath is { closed, commands } where commands are L, C, Q, or A
   * after the initial M.
   */
  function parsePath(d) {
    var tokens = tokenize(d || "");
    var i = 0;
    var cx = 0;
    var cy = 0;
    var sx = 0;
    var sy = 0;
    var prevCmd = "";
    var subpaths = [];
    var current = null;

    function read(count) {
      var values = [];
      for (var n = 0; n < count; n++) {
        if (i >= tokens.length || isCommand(tokens[i])) {
          values.push(0);
        } else {
          values.push(num(tokens[i++]));
        }
      }
      return values;
    }

    function startSubpath(x, y) {
      current = { closed: false, commands: [{ type: "M", x: x, y: y }] };
      subpaths.push(current);
      cx = x;
      cy = y;
      sx = x;
      sy = y;
    }

    function addLine(x, y) {
      if (!current) startSubpath(cx, cy);
      current.commands.push({ type: "L", x: x, y: y });
      cx = x;
      cy = y;
    }

    function reflectControl(type) {
      var last = current && current.commands[current.commands.length - 1];
      if (!last) return { x: cx, y: cy };
      if (type === "C" && last.type === "C") {
        return { x: 2 * cx - last.x2, y: 2 * cy - last.y2 };
      }
      if (type === "Q" && last.type === "Q") {
        return { x: 2 * cx - last.x1, y: 2 * cy - last.y1 };
      }
      return { x: cx, y: cy };
    }

    while (i < tokens.length) {
      var token = tokens[i];
      var cmd = token;
      if (!isCommand(token)) {
        if (prevCmd === "M") cmd = "L";
        else if (prevCmd === "m") cmd = "l";
        else cmd = prevCmd;
      } else {
        i++;
      }
      if (!cmd) break;
      var rel = cmd === cmd.toLowerCase();
      var op = cmd.toUpperCase();
      prevCmd = cmd;

      if (op === "Z") {
        if (current) current.closed = true;
        cx = sx;
        cy = sy;
        continue;
      }

      if (op === "M") {
        var pair = read(2);
        var x = rel ? cx + pair[0] : pair[0];
        var y = rel ? cy + pair[1] : pair[1];
        startSubpath(x, y);
        prevCmd = rel ? "l" : "L";
        continue;
      }

      if (op === "L") {
        var line = read(2);
        addLine(rel ? cx + line[0] : line[0], rel ? cy + line[1] : line[1]);
        continue;
      }
      if (op === "H") {
        var hx = read(1)[0];
        addLine(rel ? cx + hx : hx, cy);
        continue;
      }
      if (op === "V") {
        var hy = read(1)[0];
        addLine(cx, rel ? cy + hy : hy);
        continue;
      }
      if (op === "C") {
        var c = read(6);
        var c1x = rel ? cx + c[0] : c[0];
        var c1y = rel ? cy + c[1] : c[1];
        var c2x = rel ? cx + c[2] : c[2];
        var c2y = rel ? cy + c[3] : c[3];
        var ex = rel ? cx + c[4] : c[4];
        var ey = rel ? cy + c[5] : c[5];
        if (!current) startSubpath(cx, cy);
        current.commands.push({ type: "C", x1: c1x, y1: c1y, x2: c2x, y2: c2y, x: ex, y: ey });
        cx = ex;
        cy = ey;
        continue;
      }
      if (op === "S") {
        var s = read(4);
        var reflected = reflectControl("C");
        var s2x = rel ? cx + s[0] : s[0];
        var s2y = rel ? cy + s[1] : s[1];
        var sex = rel ? cx + s[2] : s[2];
        var sey = rel ? cy + s[3] : s[3];
        if (!current) startSubpath(cx, cy);
        current.commands.push({ type: "C", x1: reflected.x, y1: reflected.y, x2: s2x, y2: s2y, x: sex, y: sey });
        cx = sex;
        cy = sey;
        continue;
      }
      if (op === "Q") {
        var q = read(4);
        var q1x = rel ? cx + q[0] : q[0];
        var q1y = rel ? cy + q[1] : q[1];
        var qex = rel ? cx + q[2] : q[2];
        var qey = rel ? cy + q[3] : q[3];
        if (!current) startSubpath(cx, cy);
        current.commands.push({ type: "Q", x1: q1x, y1: q1y, x: qex, y: qey });
        cx = qex;
        cy = qey;
        continue;
      }
      if (op === "T") {
        var t = read(2);
        var tref = reflectControl("Q");
        var tex = rel ? cx + t[0] : t[0];
        var tey = rel ? cy + t[1] : t[1];
        if (!current) startSubpath(cx, cy);
        current.commands.push({ type: "Q", x1: tref.x, y1: tref.y, x: tex, y: tey });
        cx = tex;
        cy = tey;
        continue;
      }
      if (op === "A") {
        var a = read(7);
        var ax = rel ? cx + a[5] : a[5];
        var ay = rel ? cy + a[6] : a[6];
        if (!current) startSubpath(cx, cy);
        current.commands.push({
          type: "A",
          rx: Math.abs(a[0]),
          ry: Math.abs(a[1]),
          angle: a[2],
          large: a[3] ? 1 : 0,
          sweep: a[4] ? 1 : 0,
          x: ax,
          y: ay,
        });
        cx = ax;
        cy = ay;
        continue;
      }
    }

    return subpaths.filter(function (sub) {
      return sub.commands.length > 1;
    });
  }

  function rotateThenTranslate(x, y, placement) {
    var rad = (num(placement && placement.rotation) * Math.PI) / 180;
    var c = Math.cos(rad);
    var s = Math.sin(rad);
    var xr = x * c - y * s;
    var yr = x * s + y * c;
    return { x: xr + num(placement && placement.x), y: yr + num(placement && placement.y) };
  }

  function transformCommand(command, placement) {
    if (command.type === "M" || command.type === "L") {
      var p = rotateThenTranslate(command.x, command.y, placement);
      return { type: command.type, x: p.x, y: p.y };
    }
    if (command.type === "C") {
      var c1 = rotateThenTranslate(command.x1, command.y1, placement);
      var c2 = rotateThenTranslate(command.x2, command.y2, placement);
      var ce = rotateThenTranslate(command.x, command.y, placement);
      return { type: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: ce.x, y: ce.y };
    }
    if (command.type === "Q") {
      var q1 = rotateThenTranslate(command.x1, command.y1, placement);
      var qe = rotateThenTranslate(command.x, command.y, placement);
      return { type: "Q", x1: q1.x, y1: q1.y, x: qe.x, y: qe.y };
    }
    if (command.type === "A") {
      var end = rotateThenTranslate(command.x, command.y, placement);
      return {
        type: "A",
        rx: command.rx,
        ry: command.ry,
        angle: command.angle + num(placement && placement.rotation),
        large: command.large,
        sweep: command.sweep,
        x: end.x,
        y: end.y,
      };
    }
    return command;
  }

  function hasCurve(commands) {
    for (var i = 0; i < commands.length; i++) {
      var type = commands[i].type;
      if (type === "C" || type === "Q" || type === "A") return true;
    }
    return false;
  }

  function pointsOf(commands) {
    var points = [];
    commands.forEach(function (command) {
      if (command.type === "M" || command.type === "L" || command.type === "C" || command.type === "Q" || command.type === "A") {
        points.push({ x: command.x, y: command.y });
      }
    });
    return points;
  }

  function segmentCount(subpaths) {
    var count = 0;
    (subpaths || []).forEach(function (sub) {
      sub.commands.forEach(function (command) {
        if (command.type !== "M") count++;
      });
    });
    return count;
  }

  function pointToSegment(p, a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    if (len2 <= 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
    var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function rdpOpen(points, tolerance) {
    if (points.length < 3) return points.slice();
    var maxDist = 0;
    var index = 0;
    var a = points[0];
    var b = points[points.length - 1];
    for (var i = 1; i < points.length - 1; i++) {
      var dist = pointToSegment(points[i], a, b);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    if (maxDist > tolerance) {
      var left = rdpOpen(points.slice(0, index + 1), tolerance);
      var right = rdpOpen(points.slice(index), tolerance);
      return left.slice(0, -1).concat(right);
    }
    return [a, b];
  }

  function circleFrom3(a, b, c) {
    var d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) return null;
    var a2 = a.x * a.x + a.y * a.y;
    var b2 = b.x * b.x + b.y * b.y;
    var c2 = c.x * c.x + c.y * c.y;
    var ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    var uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    var r = Math.hypot(a.x - ux, a.y - uy);
    if (!(r > 1e-9) || r > 1e6) return null;
    return { x: ux, y: uy, r: r };
  }

  function ccwDelta(a0, a1) {
    var d = a1 - a0;
    while (d <= 0) d += TAU;
    while (d > TAU) d -= TAU;
    return d;
  }

  function signedSweep(center, from, to, via) {
    var a0 = Math.atan2(from.y - center.y, from.x - center.x);
    var a1 = Math.atan2(to.y - center.y, to.x - center.x);
    var am = Math.atan2(via.y - center.y, via.x - center.x);
    var ccw = ccwDelta(a0, a1);
    var mid = ccwDelta(a0, am);
    if (mid <= ccw + 1e-6) return ccw;
    return -(TAU - ccw);
  }

  function onSweep(center, from, to, sweep, point) {
    var a0 = Math.atan2(from.y - center.y, from.x - center.x);
    var ap = Math.atan2(point.y - center.y, point.x - center.x);
    var delta = ccwDelta(a0, ap);
    if (sweep >= 0) return delta <= sweep + 1e-3;
    return delta >= TAU + sweep - 1e-3;
  }

  function distanceToArc(point, from, to, arc) {
    var radial = Math.abs(Math.hypot(point.x - arc.center.x, point.y - arc.center.y) - arc.center.r);
    if (onSweep(arc.center, from, to, arc.sweep, point)) return radial;
    return Math.min(Math.hypot(point.x - from.x, point.y - from.y), Math.hypot(point.x - to.x, point.y - to.y));
  }

  function fitArc(from, to, via, originals, tolerance) {
    var center = circleFrom3(from, via, to);
    if (!center) return null;
    var sweep = signedSweep(center, from, to, via);
    if (Math.abs(sweep) < 1e-4 || Math.abs(Math.abs(sweep) - TAU) < 1e-3) return null;
    var arc = { center: center, sweep: sweep };
    for (var i = 0; i < originals.length; i++) {
      if (distanceToArc(originals[i], from, to, arc) > tolerance + 1e-9) return null;
    }
    if (distanceToArc(via, from, to, arc) > tolerance + 1e-9) return null;
    // The arc itself must stay within tolerance of the original polyline.
    // Otherwise a rectangle's four corners, which lie on a circle, become a bow.
    var preview = arcCommand(to, arc);
    var samples = sampleArc(from, preview, 8);
    for (var s = 0; s < samples.length; s++) {
      var best = Infinity;
      for (var p = 1; p < originals.length; p++) {
        var dist = pointToSegment(samples[s], originals[p - 1], originals[p]);
        if (dist < best) best = dist;
      }
      if (best > tolerance + 1e-9) return null;
    }
    return arc;
  }

  function arcCommand(to, arc) {
    return {
      type: "A",
      rx: arc.center.r,
      ry: arc.center.r,
      angle: 0,
      large: Math.abs(arc.sweep) > Math.PI ? 1 : 0,
      sweep: arc.sweep > 0 ? 1 : 0,
      x: to.x,
      y: to.y,
    };
  }

  function indexOfPoint(points, point) {
    for (var i = 0; i < points.length; i++) {
      if (Math.hypot(points[i].x - point.x, points[i].y - point.y) <= 1e-6) return i;
    }
    return -1;
  }

  function pointsBetween(points, from, to) {
    var i0 = indexOfPoint(points, from);
    var i1 = indexOfPoint(points, to);
    if (i0 < 0 || i1 < 0) return [from, to];
    if (i1 >= i0) return points.slice(i0, i1 + 1);
    return points.slice(i0).concat(points.slice(0, i1 + 1));
  }

  function lineRuns(points, originals, tolerance) {
    var commands = [];
    var n = points.length;
    if (n < 2) return commands;
    var i = 0;
    while (i < n - 1) {
      var best = i + 1;
      var bestArc = null;
      for (var j = i + 2; j < n; j++) {
        var from = points[i];
        var to = points[j];
        if (Math.hypot(to.x - from.x, to.y - from.y) < 1e-9) continue;
        var mid = points[i + Math.floor((j - i) / 2)];
        var arc = fitArc(from, to, mid, pointsBetween(originals, from, to), tolerance);
        if (!arc) continue;
        best = j;
        bestArc = arc;
      }
      if (bestArc) commands.push(arcCommand(points[best], bestArc));
      else commands.push({ type: "L", x: points[i + 1].x, y: points[i + 1].y });
      i = bestArc ? best : i + 1;
    }
    return commands;
  }

  function simplifyLineSubpath(commands, closed, tolerance) {
    var points = pointsOf(commands);
    if (closed && points.length > 1) {
      var last = points[points.length - 1];
      var first = points[0];
      if (Math.hypot(last.x - first.x, last.y - first.y) <= 1e-9) points.pop();
    }
    if (!(tolerance > 0) || points.length < 3) {
      return commandsFromPoints(points);
    }
    var chain = closed ? points.concat([points[0]]) : points.slice();
    var simple = rdpOpen(chain, tolerance);
    var fitted = lineRuns(simple, chain, tolerance);
    if (!fitted.length) return commandsFromPoints(simple.length ? simple : points);
    return [{ type: "M", x: simple[0].x, y: simple[0].y }].concat(fitted);
  }

  function commandsFromPoints(points) {
    if (!points.length) return [];
    var commands = [{ type: "M", x: points[0].x, y: points[0].y }];
    for (var i = 1; i < points.length; i++) {
      if (Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y) <= 1e-9) continue;
      commands.push({ type: "L", x: points[i].x, y: points[i].y });
    }
    return commands;
  }

  function transformSubpath(sub, placement) {
    return {
      closed: sub.closed,
      commands: sub.commands.map(function (command) {
        return transformCommand(command, placement);
      }),
    };
  }

  function leanSubpath(sub, placement, tolerance) {
    var transformed = transformSubpath(sub, placement);
    if (hasCurve(transformed.commands) || !(tolerance > 0)) return transformed;
    var simplified = simplifyLineSubpath(transformed.commands, transformed.closed, tolerance);
    return { closed: transformed.closed, commands: simplified };
  }

  function serializeCommand(command) {
    if (command.type === "M" || command.type === "L") {
      return command.type + fmt(command.x) + " " + fmt(command.y);
    }
    if (command.type === "C") {
      return (
        "C" +
        fmt(command.x1) +
        " " +
        fmt(command.y1) +
        " " +
        fmt(command.x2) +
        " " +
        fmt(command.y2) +
        " " +
        fmt(command.x) +
        " " +
        fmt(command.y)
      );
    }
    if (command.type === "Q") {
      return "Q" + fmt(command.x1) + " " + fmt(command.y1) + " " + fmt(command.x) + " " + fmt(command.y);
    }
    if (command.type === "A") {
      return (
        "A" +
        fmt(command.rx) +
        " " +
        fmt(command.ry) +
        " " +
        fmt(command.angle) +
        " " +
        (command.large ? 1 : 0) +
        " " +
        (command.sweep ? 1 : 0) +
        " " +
        fmt(command.x) +
        " " +
        fmt(command.y)
      );
    }
    return "";
  }

  function serializeSubpaths(subpaths) {
    var parts = [];
    (subpaths || []).forEach(function (sub) {
      sub.commands.forEach(function (command) {
        parts.push(serializeCommand(command));
      });
      if (sub.closed) parts.push("Z");
    });
    return parts.join("");
  }

  function placePath(d, placement, tolerance) {
    var source = parsePath(d);
    var placed = source.map(function (sub) {
      return leanSubpath(sub, placement || { x: 0, y: 0, rotation: 0 }, num(tolerance));
    });
    return {
      d: serializeSubpaths(placed),
      subpaths: placed,
      sourceSegments: segmentCount(source),
      segments: segmentCount(placed),
    };
  }

  function placePolyline(points, closed, placement, tolerance) {
    var commands = [{ type: "M", x: points[0].x, y: points[0].y }];
    for (var i = 1; i < points.length; i++) {
      commands.push({ type: "L", x: points[i].x, y: points[i].y });
    }
    var sub = { closed: !!closed, commands: commands };
    var placed = leanSubpath(sub, placement || { x: 0, y: 0, rotation: 0 }, num(tolerance));
    return {
      d: serializeSubpaths([placed]),
      subpaths: [placed],
      sourceSegments: Math.max(0, points.length - (closed ? 0 : 1)),
      segments: segmentCount([placed]),
    };
  }

  function sampleArc(from, command, steps) {
    var rx = command.rx;
    var ry = command.ry;
    var phi = (command.angle * Math.PI) / 180;
    var cos = Math.cos(phi);
    var sin = Math.sin(phi);
    var dx = (from.x - command.x) / 2;
    var dy = (from.y - command.y) / 2;
    var x1p = cos * dx + sin * dy;
    var y1p = -sin * dx + cos * dy;
    var rx2 = rx * rx;
    var ry2 = ry * ry;
    var lam = (x1p * x1p) / rx2 + (y1p * y1p) / ry2;
    if (lam > 1) {
      var scale = Math.sqrt(lam);
      rx *= scale;
      ry *= scale;
      rx2 = rx * rx;
      ry2 = ry * ry;
    }
    var sign = command.large === command.sweep ? -1 : 1;
    var sq = Math.max(0, (rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p) / (rx2 * y1p * y1p + ry2 * x1p * x1p));
    var coef = sign * Math.sqrt(sq);
    var cxp = coef * ((rx * y1p) / ry);
    var cyp = coef * -((ry * x1p) / rx);
    var cx = cos * cxp - sin * cyp + (from.x + command.x) / 2;
    var cy = sin * cxp + cos * cyp + (from.y + command.y) / 2;
    function angle(ux, uy, vx, vy) {
      var dot = ux * vx + uy * vy;
      var det = ux * vy - uy * vx;
      var a = Math.atan2(det, dot);
      return a;
    }
    var ux = (x1p - cxp) / rx;
    var uy = (y1p - cyp) / ry;
    var vx = (-x1p - cxp) / rx;
    var vy = (-y1p - cyp) / ry;
    var theta = Math.atan2(uy, ux);
    var delta = angle(ux, uy, vx, vy);
    if (!command.sweep && delta > 0) delta -= TAU;
    if (command.sweep && delta < 0) delta += TAU;
    var count = steps || 8;
    var samples = [];
    for (var s = 0; s <= count; s++) {
      var t = theta + (delta * s) / count;
      var xp = rx * Math.cos(t);
      var yp = ry * Math.sin(t);
      samples.push({
        x: cos * xp - sin * yp + cx,
        y: sin * xp + cos * yp + cy,
      });
    }
    return samples;
  }

  function sampleCommand(from, command, steps) {
    if (command.type === "L" || command.type === "M") return [from, { x: command.x, y: command.y }];
    if (command.type === "A") return sampleArc(from, command, steps || 12);
    if (command.type === "C" || command.type === "Q") {
      var samples = [];
      var count = steps || 12;
      for (var s = 0; s <= count; s++) {
        var t = s / count;
        samples.push(bezierPoint(from, command, t));
      }
      return samples;
    }
    return [from, { x: command.x, y: command.y }];
  }

  function bezierPoint(from, command, t) {
    var u = 1 - t;
    if (command.type === "Q") {
      return {
        x: u * u * from.x + 2 * u * t * command.x1 + t * t * command.x,
        y: u * u * from.y + 2 * u * t * command.y1 + t * t * command.y,
      };
    }
    return {
      x:
        u * u * u * from.x +
        3 * u * u * t * command.x1 +
        3 * u * t * t * command.x2 +
        t * t * t * command.x,
      y:
        u * u * u * from.y +
        3 * u * u * t * command.y1 +
        3 * u * t * t * command.y2 +
        t * t * t * command.y,
    };
  }

  function pathSamples(subpaths, steps) {
    var samples = [];
    (subpaths || []).forEach(function (sub) {
      var cursor = sub.commands[0];
      for (var i = 1; i < sub.commands.length; i++) {
        var command = sub.commands[i];
        var piece = sampleCommand(cursor, command, steps);
        piece.forEach(function (point) {
          samples.push(point);
        });
        cursor = command;
      }
    });
    return samples;
  }

  function maxDeviation(points, subpaths) {
    if (!points || !points.length) return 0;
    var samples = pathSamples(subpaths, 16);
    if (!samples.length) return Infinity;
    var max = 0;
    points.forEach(function (point) {
      var best = Infinity;
      for (var i = 1; i < samples.length; i++) {
        var dist = pointToSegment(point, samples[i - 1], samples[i]);
        if (dist < best) best = dist;
      }
      if (best > max) max = best;
    });
    return max;
  }

  function polylineVertices(sub) {
    var vertices = [];
    var cursor = sub.commands[0];
    for (var i = 1; i < sub.commands.length; i++) {
      var command = sub.commands[i];
      var bulge = 0;
      if (command.type === "A") {
        var samples = sampleArc(cursor, command, 2);
        var via = samples[1];
        var center = circleFrom3(cursor, via, command);
        if (center) {
          var sweep = signedSweep(center, cursor, command, via);
          bulge = Math.tan(sweep / 4);
        }
      }
      vertices.push({ x: cursor.x, y: cursor.y, bulge: bulge });
      cursor = command;
    }
    if (!sub.closed) {
      vertices.push({ x: cursor.x, y: cursor.y, bulge: 0 });
    }
    return { closed: !!sub.closed, vertices: vertices };
  }

  function toDxf(subpaths, scale, units) {
    var factor = scale > 0 ? scale : 1;
    var lines = [
      "0",
      "SECTION",
      "2",
      "HEADER",
      "9",
      "$INSUNITS",
      "70",
      units === "mm" ? "4" : "1",
      "0",
      "ENDSEC",
      "0",
      "SECTION",
      "2",
      "ENTITIES",
    ];
    (subpaths || []).forEach(function (sub) {
      var poly = polylineVertices(sub);
      if (poly.vertices.length < 2) return;
      lines.push("0", "LWPOLYLINE", "8", "0", "90", String(poly.vertices.length), "70", poly.closed ? "1" : "0");
      poly.vertices.forEach(function (vertex) {
        lines.push("10", fmt(vertex.x * factor), "20", fmt(vertex.y * factor), "42", fmt(vertex.bulge || 0));
      });
    });
    lines.push("0", "ENDSEC", "0", "EOF");
    return lines.join("\n");
  }

  return {
    parsePath: parsePath,
    placePath: placePath,
    placePolyline: placePolyline,
    segmentCount: segmentCount,
    serializeSubpaths: serializeSubpaths,
    maxDeviation: maxDeviation,
    pathSamples: pathSamples,
    toDxf: toDxf,
    rotateThenTranslate: rotateThenTranslate,
  };
});
