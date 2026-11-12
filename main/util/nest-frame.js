/**
 * Frame a nest in the results pane.
 *
 * The viewBox is the sheet, in the sheet's own orientation. Parts are placed
 * with an SVG translate-then-rotate in those same units, so a rotation stays
 * on the plate instead of swinging around the browser viewport.
 */
"use strict";

function layoutNest(placements, boundsFor) {
  var svgWidth = 0;
  var svgHeight = 0;
  var parts = [];
  var sheets = placements || [];
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    var bounds = boundsFor(sheet.sheet);
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) continue;
    var y0 = svgHeight;
    if (bounds.width > svgWidth) svgWidth = bounds.width;
    var spots = sheet.sheetplacements || [];
    for (var j = 0; j < spots.length; j++) {
      var spot = spots[j];
      var x = spot.x - bounds.x;
      var y = spot.y + y0 - bounds.y;
      var rotation = spot.rotation || 0;
      parts.push({
        id: spot.id,
        source: spot.source,
        x: x,
        y: y,
        rotation: rotation,
        transform: "translate(" + x + " " + y + ") rotate(" + rotation + ")",
      });
    }
    svgHeight += 1.1 * bounds.height;
  }
  if (!(svgWidth > 0)) svgWidth = 1;
  if (!(svgHeight > 0)) svgHeight = 1;
  return {
    x: 0,
    y: 0,
    width: svgWidth,
    height: svgHeight,
    viewBox: "0 0 " + svgWidth + " " + svgHeight,
    landscape: svgWidth >= svgHeight * 1.05,
    parts: parts,
  };
}

/** A part's axis-aligned box after the same rotate-then-translate the SVG uses. */
function placedBox(local, placement) {
  var w = local.width;
  var h = local.height;
  var rad = ((placement.rotation || 0) * Math.PI) / 180;
  var c = Math.cos(rad);
  var s = Math.sin(rad);
  var corners = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  var minX = Infinity;
  var minY = Infinity;
  var maxX = -Infinity;
  var maxY = -Infinity;
  corners.forEach(function (corner) {
    var rx = corner.x * c - corner.y * s;
    var ry = corner.x * s + corner.y * c;
    var x = rx + placement.x;
    var y = ry + placement.y;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function insideFrame(box, frame, slack) {
  var pad = slack || 0;
  return (
    box.x >= frame.x - pad &&
    box.y >= frame.y - pad &&
    box.x + box.width <= frame.x + frame.width + pad &&
    box.y + box.height <= frame.y + frame.height + pad
  );
}

module.exports = {
  layoutNest: layoutNest,
  placedBox: placedBox,
  insideFrame: insideFrame,
};
