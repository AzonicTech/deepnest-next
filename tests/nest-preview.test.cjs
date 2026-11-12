"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Frame = require("../main/util/nest-frame.js");

const SHEET = { x: 0, y: 0, width: 4800, height: 1000 };

function wideJob() {
  return {
    placements: [
      {
        sheet: 0,
        sheetid: "0000-0000",
        sheetplacements: [
          { id: 1, source: 1, x: 100, y: 100, rotation: 0 },
          { id: 2, source: 2, x: 1200, y: 200, rotation: 90 },
        ],
      },
    ],
  };
}

test("a wide sheet frames landscape and keeps a rotated part on the plate", () => {
  const frame = Frame.layoutNest(wideJob().placements, () => SHEET);
  assert.equal(frame.viewBox, "0 0 4800 1100");
  assert.equal(frame.landscape, true);
  assert.equal(frame.width > frame.height, true);

  const flat = Frame.placedBox({ width: 800, height: 120 }, { x: 100, y: 100, rotation: 0 });
  const turned = Frame.placedBox({ width: 400, height: 80 }, { x: 1200, y: 200, rotation: 90 });
  assert.equal(Frame.insideFrame(flat, { x: 0, y: 0, width: SHEET.width, height: SHEET.height }), true);
  assert.equal(Frame.insideFrame(turned, { x: 0, y: 0, width: SHEET.width, height: SHEET.height }), true);
  assert.equal(frame.parts[1].transform, "translate(1200 200) rotate(90)");
});

test("the results pane fits the whole wide sheet, including a rotated part", async () => {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (err) {
    assert.fail("playwright is not installed: " + err.message);
  }

  const frame = Frame.layoutNest(wideJob().placements, () => SHEET);
  const html = `<!DOCTYPE html>
<html>
<head>
<style>
  html, body { margin: 0; background: #404247; }
  #nestdisplay { width: 1200px; height: 800px; position: relative; overflow: hidden; }
  #nestdisplay svg { width: 95%; height: auto; display: block; overflow: hidden; }
</style>
</head>
<body>
  <div id="nestdisplay">
    <svg id="nestsvg" xmlns="http://www.w3.org/2000/svg" viewBox="${frame.viewBox}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%">
      <rect id="sheet" x="0" y="0" width="${SHEET.width}" height="${SHEET.height}" fill="none" stroke="#fff"/>
      <rect class="part" x="0" y="0" width="800" height="120" transform="translate(100 100) rotate(0)" fill="#88f"/>
      <rect class="part" x="0" y="0" width="400" height="80" transform="translate(1200 200) rotate(90)" fill="#8f8"/>
    </svg>
  </div>
</body>
</html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.setContent(html);
    const measured = await page.evaluate(() => {
      const pane = document.querySelector("#nestdisplay").getBoundingClientRect();
      const sheet = document.querySelector("#sheet").getBoundingClientRect();
      const parts = Array.from(document.querySelectorAll(".part")).map((el) => el.getBoundingClientRect());
      const svg = document.querySelector("#nestsvg");
      return {
        pane: { width: pane.width, height: pane.height, left: pane.left, top: pane.top, right: pane.right, bottom: pane.bottom },
        sheet: { width: sheet.width, height: sheet.height, left: sheet.left, top: sheet.top, right: sheet.right, bottom: sheet.bottom },
        parts: parts.map((box) => ({ left: box.left, top: box.top, right: box.right, bottom: box.bottom })),
        viewBox: svg.getAttribute("viewBox"),
      };
    });

    assert.equal(measured.viewBox, "0 0 4800 1100");
    assert.ok(measured.sheet.width > measured.sheet.height * 3, "sheet should stay landscape, got " + JSON.stringify(measured.sheet));
    assert.ok(
      measured.sheet.width > measured.pane.width * 0.9,
      "sheet should fill the pane width, got " + measured.sheet.width + " of " + measured.pane.width
    );
    assert.ok(measured.sheet.left >= measured.pane.left - 1);
    assert.ok(measured.sheet.right <= measured.pane.right + 1);
    assert.ok(measured.sheet.top >= measured.pane.top - 1);
    assert.ok(measured.sheet.bottom <= measured.pane.bottom + 1, "sheet runs off the pane: " + JSON.stringify(measured));
    measured.parts.forEach((part, index) => {
      assert.ok(part.left >= measured.pane.left - 1, "part " + index + " left " + part.left);
      assert.ok(part.top >= measured.pane.top - 1, "part " + index + " top " + part.top);
      assert.ok(part.right <= measured.pane.right + 1, "part " + index + " right " + part.right);
      assert.ok(part.bottom <= measured.pane.bottom + 1, "part " + index + " bottom " + part.bottom);
    });
  } finally {
    await browser.close();
  }
});
