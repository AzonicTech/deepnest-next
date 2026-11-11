"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const dwg = require("../main/util/dwg-to-dxf.js");
const { convertDxf } = require("../main/util/dxf-to-svg.js");

const LINE_DXF = [
  "0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "1", "0", "ENDSEC",
  "0", "SECTION", "2", "ENTITIES",
  "0", "LINE", "8", "0", "10", "0", "20", "0", "11", "10", "21", "0",
  "0", "ENDSEC", "0", "EOF", "",
].join("\n");

function child() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = function () {
    proc.killed = true;
  };
  return proc;
}

function detector(extra) {
  const allow = new Set(extra || []);
  return function existsSync(file) {
    return allow.has(file);
  };
}

test("reports a missing ODA install instead of calling a converter", async () => {
  const result = await dwg.convertDwg("/tmp/blade.dwg", {
    platform: "linux",
    homedir: "/home/craig",
    env: { PATH: "" },
    existsSync: detector(),
    readdirSync: function () { return []; },
    spawn: function () { throw new Error("spawn should not run"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "missing");
  assert.equal(result.message, dwg.MISSING_ODA_MESSAGE);
});

test("auto-detects ODA under /opt, an AppImage, and Windows Program Files", () => {
  const home = "/home/craig";
  const appImage = path.join(home, "Downloads", "ODAFileConverter_QT6.AppImage");
  const optBin = "/opt/ODAFileConverter_26.7.0/ODAFileConverter";
  const linux = dwg.findConverter({
    platform: "linux",
    homedir: home,
    env: { PATH: "" },
    existsSync: detector([appImage, optBin, "/opt", home + "/Downloads"]),
    readdirSync: function (dir) {
      if (dir === "/opt") return ["ODAFileConverter_26.7.0"];
      if (dir === home + "/Downloads") return ["ODAFileConverter_QT6.AppImage"];
      return [];
    },
  });
  assert.equal(linux.kind, "oda");
  assert.equal(linux.bin, optBin);

  const onlyImage = dwg.findConverter({
    platform: "linux",
    homedir: home,
    env: { PATH: "" },
    existsSync: detector([appImage, path.join(home, "Downloads")]),
    readdirSync: function (dir) {
      if (dir === path.join(home, "Downloads")) return ["ODAFileConverter_QT6.AppImage"];
      return [];
    },
  });
  assert.equal(onlyImage.bin, appImage);

  const win = path.win32;
  const exe = win.join("C:\\Program Files", "ODA", "ODAFileConverter 26.7", "ODAFileConverter.exe");
  const windows = dwg.findConverter({
    platform: "win32",
    path: win,
    homedir: "C:\\Users\\craig",
    env: { PATH: "", ProgramFiles: "C:\\Program Files" },
    existsSync: function (file) {
      return file === exe || file === win.join("C:\\Program Files", "ODA");
    },
    readdirSync: function () { return ["ODAFileConverter 26.7"]; },
  });
  assert.equal(windows.bin, exe);
});

test("a configured ODA path converts a DWG to DXF and removes the temp dirs", async () => {
  const source = path.join(os.tmpdir(), "deepnest-blade-" + process.pid + ".dwg");
  fs.writeFileSync(source, "dwg");
  const calls = [];
  let base = "";
  const result = await dwg.convertDwg(source, {
    odaPath: "/opt/oda/ODAFileConverter",
    platform: "linux",
    env: { PATH: "" },
    existsSync: detector(["/opt/oda/ODAFileConverter"]),
    readdirSync: function () { return []; },
    spawn: function (cmd, args, opts) {
      calls.push({ cmd: cmd, args: args, env: opts.env });
      base = path.dirname(args[0]);
      const proc = child();
      setImmediate(function () {
        fs.writeFileSync(path.join(args[1], "blade.dxf"), LINE_DXF);
        proc.emit("exit", 0, null);
      });
      return proc;
    },
  });
  fs.rmSync(source, { force: true });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "/opt/oda/ODAFileConverter");
  assert.deepEqual(calls[0].args.slice(2, 6), ["ACAD2018", "DXF", "0", "1"]);
  assert.equal(calls[0].args[6], path.basename(source));
  assert.equal(calls[0].env.QT_QPA_PLATFORM, "offscreen");
  assert.equal(fs.existsSync(base), false);
  const svg = convertDxf(result.dxf);
  assert.equal(svg.commands.line, 1);
  assert.ok(svg.bounds.maxX > 9);
});

test("a nonzero ODA exit is reported, and xvfb-run is the second try", async () => {
  const source = path.join(os.tmpdir(), "deepnest-fail-" + process.pid + ".dwg");
  fs.writeFileSync(source, "dwg");
  const plain = await dwg.convertDwg(source, {
    odaPath: "/usr/bin/ODAFileConverter",
    platform: "linux",
    env: { PATH: "" },
    existsSync: detector(["/usr/bin/ODAFileConverter"]),
    readdirSync: function () { return []; },
    spawn: function () {
      const proc = child();
      setImmediate(function () { proc.emit("exit", 3, null); });
      return proc;
    },
  });
  assert.equal(plain.ok, false);
  assert.equal(plain.code, "exit");
  assert.match(plain.message, /exit 3/);

  const calls = [];
  const retried = await dwg.convertDwg(source, {
    odaPath: "/usr/bin/ODAFileConverter",
    platform: "linux",
    env: { PATH: "" },
    existsSync: detector(["/usr/bin/ODAFileConverter", "/usr/bin/xvfb-run"]),
    readdirSync: function () { return []; },
    spawn: function (cmd, args) {
      calls.push(cmd);
      const proc = child();
      setImmediate(function () {
        if (calls.length === 1) {
          proc.emit("exit", 1, null);
          return;
        }
        fs.writeFileSync(path.join(args[3], "fail.dxf"), LINE_DXF);
        proc.emit("exit", 0, null);
      });
      return proc;
    },
  });
  fs.rmSync(source, { force: true });
  assert.deepEqual(calls, ["/usr/bin/ODAFileConverter", "/usr/bin/xvfb-run"]);
  assert.equal(retried.ok, true);
});

test("a hung ODA process is killed at the timeout and the temp dir is removed", async () => {
  const source = path.join(os.tmpdir(), "deepnest-hang-" + process.pid + ".dwg");
  fs.writeFileSync(source, "dwg");
  let base = "";
  let killed = false;
  const result = await dwg.convertDwg(source, {
    odaPath: "/usr/bin/ODAFileConverter",
    platform: "linux",
    env: { PATH: "" },
    timeoutMs: 40,
    existsSync: detector(["/usr/bin/ODAFileConverter"]),
    readdirSync: function () { return []; },
    spawn: function (cmd, args) {
      base = path.dirname(args[0]);
      const proc = child();
      proc.kill = function () { killed = true; };
      return proc;
    },
  });
  fs.rmSync(source, { force: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, "timeout");
  assert.match(result.message, /timed out/);
  assert.equal(killed, true);
  assert.equal(fs.existsSync(base), false);
});

test("dwg2dxf is used only when ODA is not installed", async () => {
  const source = path.join(os.tmpdir(), "deepnest-libre-" + process.pid + ".dwg");
  fs.writeFileSync(source, "dwg");
  const calls = [];
  const result = await dwg.convertDwg(source, {
    platform: "linux",
    homedir: "/home/craig",
    env: { PATH: "/usr/bin" },
    existsSync: detector(["/usr/bin/dwg2dxf"]),
    readdirSync: function () { return []; },
    spawn: function (cmd, args) {
      calls.push({ cmd: cmd, args: args });
      const proc = child();
      setImmediate(function () {
        fs.writeFileSync(args[args.indexOf("-o") + 1], LINE_DXF);
        proc.emit("exit", 0, null);
      });
      return proc;
    },
  });
  fs.rmSync(source, { force: true });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "libredwg");
  assert.equal(calls[0].cmd, "/usr/bin/dwg2dxf");
  assert.equal(calls[0].args[0], "-y");
  assert.equal(calls[0].args[1], "-o");
});

test("the DXF copy is kept beside the DWG after the temp dirs are removed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepnest-job-"));
  const source = path.join(dir, "blade.dwg");
  const copyTo = path.join(dir, "blade.converted.dxf");
  fs.writeFileSync(source, "not a dxf");
  let base = "";
  const result = await dwg.convertDwg(source, {
    odaPath: "/usr/bin/ODAFileConverter",
    platform: "linux",
    env: { PATH: "" },
    copyTo: copyTo,
    existsSync: detector(["/usr/bin/ODAFileConverter"]),
    readdirSync: function () { return []; },
    spawn: function (cmd, args) {
      base = path.dirname(args[0]);
      const proc = child();
      setImmediate(function () {
        fs.writeFileSync(path.join(args[1], "blade.dxf"), LINE_DXF);
        proc.emit("exit", 0, null);
      });
      return proc;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.savedDxf, copyTo);
  assert.equal(fs.existsSync(base), false);
  assert.equal(fs.readFileSync(source, "utf8"), "not a dxf");
  assert.match(fs.readFileSync(copyTo, "utf8"), /LINE/);
  fs.rmSync(dir, { recursive: true, force: true });
});
