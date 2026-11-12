"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const folders = require("../main/util/work-folder.js");

const CUSTOMERS = "/home/tv3d/Robo-Jet/Water-Jet Customers";
const HOME = "/home/tv3d";

function existsIn(paths) {
  const allow = new Set(paths);
  return function existsSync(file) {
    return allow.has(file);
  };
}

test("before any import, dialogs open in the default work folder", () => {
  folders.resetSession();
  const start = folders.resolveWorkFolder({
    defaultWorkFolder: CUSTOMERS,
    home: HOME,
    existsSync: existsIn([CUSTOMERS, HOME]),
  });
  assert.equal(start, CUSTOMERS);
  assert.ok(start.includes("Water-Jet Customers"));
  assert.equal(start.indexOf("Water-Jet Customers"), start.lastIndexOf("Water-Jet Customers"));
});

test("an empty default uses home, and a missing default falls back to home", () => {
  folders.resetSession();
  assert.equal(
    folders.resolveWorkFolder({
      defaultWorkFolder: "",
      home: HOME,
      existsSync: existsIn([HOME]),
    }),
    HOME,
  );
  assert.equal(
    folders.resolveWorkFolder({
      defaultWorkFolder: "/home/tv3d/missing folder",
      home: HOME,
      existsSync: existsIn([HOME]),
    }),
    HOME,
  );
  assert.equal(
    folders.resolveWorkFolder({
      defaultWorkFolder: "/gone",
      home: "/also-gone",
      existsSync: existsIn([]),
    }),
    "",
  );
});

test("the most recent import folder is used, including paths with spaces", () => {
  folders.resetSession();
  const first = CUSTOMERS + "/acme/blade.dwg";
  const second = CUSTOMERS + "/other shop/utility.dxf";
  assert.equal(folders.noteImport(first), CUSTOMERS + "/acme");
  assert.equal(folders.noteImport(second), CUSTOMERS + "/other shop");
  const start = folders.resolveWorkFolder({
    defaultWorkFolder: CUSTOMERS,
    home: HOME,
    sessionFolder: folders.getSessionFolder(),
    existsSync: existsIn([CUSTOMERS + "/other shop", CUSTOMERS, HOME]),
  });
  assert.equal(start, CUSTOMERS + "/other shop");
  assert.equal(
    folders.saveDialogPath(start, folders.getImportStems(), "dxf"),
    CUSTOMERS + "/other shop/blade-utility.dxf",
  );
});

test("a missing job folder falls back to the default, then home", () => {
  const start = folders.resolveWorkFolder({
    sessionFolder: CUSTOMERS + "/deleted job",
    defaultWorkFolder: CUSTOMERS,
    home: HOME,
    existsSync: existsIn([CUSTOMERS, HOME]),
  });
  assert.equal(start, CUSTOMERS);
  const homeOnly = folders.resolveWorkFolder({
    sessionFolder: CUSTOMERS + "/deleted job",
    defaultWorkFolder: CUSTOMERS + "/also missing",
    home: HOME,
    existsSync: existsIn([HOME]),
  });
  assert.equal(homeOnly, HOME);
});

test("a converted DXF is named beside the DWG and does not clobber", () => {
  const dir = CUSTOMERS + "/acme";
  const first = folders.convertedDxfPath(dir, "blade.dwg", existsIn([]));
  assert.equal(first, dir + "/blade.converted.dxf");
  assert.notEqual(first, dir + "/blade.dwg");
  const second = folders.convertedDxfPath(dir, "blade.dwg", existsIn([first]));
  assert.equal(second, dir + "/blade.converted-2.dxf");
  const third = folders.convertedDxfPath(
    dir,
    "blade.dwg",
    existsIn([first, second]),
  );
  assert.equal(third, dir + "/blade.converted-3.dxf");
});

test("several imports suggest one export name", () => {
  folders.resetSession();
  folders.noteImport("/jobs/a knife.dxf");
  folders.noteImport("/jobs/b.dxf");
  folders.noteImport("/jobs/c.dxf");
  assert.equal(folders.saveDialogPath("/jobs", folders.getImportStems(), "svg"), "/jobs/a knife-and-2-more.svg");
});
