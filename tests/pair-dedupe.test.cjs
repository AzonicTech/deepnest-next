"use strict";

/**
 * The NFP pair list must stay the same set the old linear scan produced.
 * Only the lookup cost is allowed to change.
 *
 *   node --test tests/pair-dedupe.test.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadBackground() {
  const context = {
    console,
    Math,
    Set,
    JSON,
    navigator: { userAgent: "chrome", appName: "Netscape", hardwareConcurrency: 4 },
    ipcRenderer: { send() {} },
    addon: { calculateNFP() { return null; } },
    process: { env: {} },
  };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  const background = fs
    .readFileSync(path.join(__dirname, "../main/background.js"), "utf8")
    .replace(/^import .*;\s*$/gm, "");
  vm.runInContext(background, context, { filename: "background.js" });
  return context;
}

function referencePairs(parts, db) {
  const pairs = [];
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
        A,
        B,
        Arotation: A.rotation,
        Brotation: B.rotation,
        Asource: A.source,
        Bsource: B.source,
      };
      const doc = {
        A: A.source,
        B: B.source,
        Arotation: A.rotation,
        Brotation: B.rotation,
      };
      if (!inpairs(key) && !db.has(doc)) {
        pairs.push(key);
      }
    }
  }
  return pairs;
}

function keyOf(pair) {
  return pair.Asource + "|" + pair.Bsource + "|" + pair.Arotation + "|" + pair.Brotation;
}

function makeDb(existing) {
  const have = new Set(existing || []);
  return {
    has(doc) {
      return have.has(doc.A + "|" + doc.B + "|" + doc.Arotation + "|" + doc.Brotation);
    },
  };
}

test("buildNfpPairs matches the linear scan, including cached skips", () => {
  const context = loadBackground();
  assert.equal(typeof context.buildNfpPairs, "function");

  let seed = 20261010;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  for (let trial = 0; trial < 30; trial++) {
    const n = 5 + Math.floor(random() * 40);
    const parts = [];
    for (let i = 0; i < n; i++) {
      parts.push({
        source: Math.floor(random() * 8),
        rotation: Math.floor(random() * 4) * 90,
        id: i,
      });
    }
    const cached = [];
    const cacheCount = Math.floor(random() * 6);
    for (let c = 0; c < cacheCount; c++) {
      const a = parts[Math.floor(random() * parts.length)];
      const b = parts[Math.floor(random() * parts.length)];
      cached.push(a.source + "|" + b.source + "|" + a.rotation + "|" + b.rotation);
    }
    const db = makeDb(cached);
    const expected = referencePairs(parts, db).map(keyOf).sort();
    const actual = context.buildNfpPairs(parts, db).map(keyOf).sort();
    assert.equal(
      actual.join("\n"),
      expected.join("\n"),
      "trial " + trial + " expected " + expected.length + " got " + actual.length,
    );
  }
});
