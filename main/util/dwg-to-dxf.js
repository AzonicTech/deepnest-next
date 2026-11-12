/**
 * DWG → DXF using a local converter. ODA File Converter is not shipped with
 * the app. When it is installed, this runs it headless and returns the DXF
 * bytes. LibreDWG's dwg2dxf is used only when ODA is not found.
 */
"use strict";

const nodeFs = require("fs");
const nodePath = require("path");
const nodeOs = require("os");
const { spawn: nodeSpawn } = require("child_process");

const MISSING_ODA_MESSAGE =
  "DWG needs the free ODA File Converter. Install it, then set its path in Settings.";

const DEFAULT_TIMEOUT_MS = 120000;

function unique(list) {
  const seen = {};
  const out = [];
  list.forEach(function (item) {
    if (!item || seen[item]) return;
    seen[item] = true;
    out.push(item);
  });
  return out;
}

function safeName(base) {
  const cleaned = String(base || "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") return "drawing.dwg";
  if (!/\.dwg$/i.test(cleaned)) return cleaned + ".dwg";
  return cleaned;
}

function pathDirs(env, pathMod) {
  return String((env && env.PATH) || "")
    .split(pathMod.delimiter)
    .filter(function (dir) { return dir; });
}

function which(name, existsSync, env, pathMod) {
  const found = [];
  pathDirs(env, pathMod).forEach(function (dir) {
    const candidate = pathMod.join(dir, name);
    if (existsSync(candidate)) found.push(candidate);
  });
  return found;
}

function readNames(dir, readdirSync) {
  try {
    return readdirSync(dir) || [];
  } catch (err) {
    void err;
    return [];
  }
}

function odaCandidates(ctx) {
  const pathMod = ctx.path;
  const existsSync = ctx.existsSync;
  const list = [];
  if (ctx.platform === "win32") {
    const roots = unique([
      ctx.env.ProgramFiles,
      ctx.env["ProgramFiles(x86)"],
      "C:\\Program Files",
      "C:\\Program Files (x86)",
    ]);
    roots.forEach(function (root) {
      const oda = pathMod.join(root, "ODA");
      list.push(pathMod.join(oda, "ODAFileConverter.exe"));
      if (existsSync(oda)) {
        readNames(oda, ctx.readdirSync).forEach(function (name) {
          if (/^ODAFileConverter/i.test(name)) {
            list.push(pathMod.join(oda, name, "ODAFileConverter.exe"));
          }
        });
      }
    });
    which("ODAFileConverter.exe", existsSync, ctx.env, pathMod).forEach(function (hit) {
      list.push(hit);
    });
    return unique(list);
  }

  list.push("/usr/bin/ODAFileConverter", "/usr/local/bin/ODAFileConverter");
  if (existsSync("/opt")) {
    readNames("/opt", ctx.readdirSync).forEach(function (name) {
      if (/^ODAFileConverter/i.test(name)) {
        list.push(pathMod.join("/opt", name, "ODAFileConverter"));
      }
    });
  }
  [pathMod.join(ctx.homedir, "Applications"), pathMod.join(ctx.homedir, "Downloads")].forEach(function (dir) {
    if (!existsSync(dir)) return;
    readNames(dir, ctx.readdirSync).forEach(function (name) {
      if (/ODAFileConverter/i.test(name)) list.push(pathMod.join(dir, name));
    });
  });
  which("ODAFileConverter", existsSync, ctx.env, pathMod).forEach(function (hit) {
    list.push(hit);
  });
  return unique(list);
}

function context(options) {
  const pathMod = (options && options.path) || nodePath;
  return {
    fs: (options && options.fs) || nodeFs,
    path: pathMod,
    existsSync: (options && options.existsSync) || ((options && options.fs) || nodeFs).existsSync.bind((options && options.fs) || nodeFs),
    readdirSync: (options && options.readdirSync) || ((options && options.fs) || nodeFs).readdirSync.bind((options && options.fs) || nodeFs),
    platform: (options && options.platform) || process.platform,
    homedir: (options && options.homedir) || nodeOs.homedir(),
    env: (options && options.env) || process.env,
    odaPath: options && options.odaPath ? String(options.odaPath).trim() : "",
  };
}

function findConverter(options) {
  const ctx = context(options);
  if (ctx.odaPath && ctx.existsSync(ctx.odaPath)) {
    return { bin: ctx.odaPath, kind: "oda" };
  }
  const candidates = odaCandidates(ctx);
  for (let i = 0; i < candidates.length; i++) {
    if (ctx.existsSync(candidates[i])) return { bin: candidates[i], kind: "oda" };
  }
  const libreName = ctx.platform === "win32" ? "dwg2dxf.exe" : "dwg2dxf";
  const libre = which(libreName, ctx.existsSync, ctx.env, ctx.path);
  if (libre.length) return { bin: libre[0], kind: "libredwg" };
  return null;
}

function findXvfb(ctx) {
  if (ctx.platform !== "linux") return "";
  if (ctx.existsSync("/usr/bin/xvfb-run")) return "/usr/bin/xvfb-run";
  const hits = which("xvfb-run", ctx.existsSync, ctx.env, ctx.path);
  return hits[0] || "";
}

function textOf(chunks) {
  if (!chunks.length) return "";
  return Buffer.concat(chunks).toString("utf8");
}

function runCommand(spawn, command, args, env, timeoutMs) {
  return new Promise(function (resolve) {
    var settled = false;
    var stdout = [];
    var stderr = [];
    var timer = null;
    var child;
    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      result.stdout = textOf(stdout);
      result.stderr = textOf(stderr);
      resolve(result);
    }
    try {
      child = spawn(command, args, {
        env: env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ code: null, error: err, timedOut: false });
      return;
    }
    if (!child || typeof child.on !== "function") {
      finish({ code: null, error: new Error("Could not start the converter"), timedOut: false });
      return;
    }
    if (child.stdout && child.stdout.on) {
      child.stdout.on("data", function (chunk) { stdout.push(Buffer.from(chunk)); });
    }
    if (child.stderr && child.stderr.on) {
      child.stderr.on("data", function (chunk) { stderr.push(Buffer.from(chunk)); });
    }
    child.on("error", function (err) {
      finish({ code: null, error: err, timedOut: false });
    });
    child.on("exit", function (code) {
      finish({ code: code, error: null, timedOut: false });
    });
    timer = setTimeout(function () {
      try {
        if (typeof child.kill === "function") child.kill("SIGKILL");
      } catch (err) {
        void err;
      }
      finish({ code: null, error: new Error("timeout"), timedOut: true });
    }, timeoutMs);
  });
}

function envWithout(name, source) {
  const next = {};
  Object.keys(source || {}).forEach(function (key) {
    if (key !== name) next[key] = source[key];
  });
  return next;
}

function findDxf(dir, fs, pathMod) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    void err;
    return "";
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const name = entry.name || String(entry);
    const full = pathMod.join(dir, name);
    const isDir = typeof entry.isDirectory === "function" ? entry.isDirectory() : false;
    if (isDir) {
      const nested = findDxf(full, fs, pathMod);
      if (nested) return nested;
    } else if (/\.dxf$/i.test(name)) {
      return full;
    }
  }
  return "";
}

function failureMessage(kind, run) {
  const name = kind === "libredwg" ? "LibreDWG dwg2dxf" : "ODA File Converter";
  if (run.timedOut) return { ok: false, code: "timeout", message: name + " timed out." };
  if (run.error && run.error.code === "ENOENT") {
    return { ok: false, code: "missing", message: MISSING_ODA_MESSAGE };
  }
  const code = run.code == null ? "unknown" : String(run.code);
  return { ok: false, code: "exit", message: name + " failed (exit " + code + ")." };
}

async function convertDwg(dwgPath, options) {
  const opts = options || {};
  const ctx = context(opts);
  const fs = ctx.fs;
  const pathMod = ctx.path;
  const spawn = opts.spawn || nodeSpawn;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const found = findConverter(opts);
  if (!found) return { ok: false, code: "missing", message: MISSING_ODA_MESSAGE };

  const base = fs.mkdtempSync(pathMod.join(nodeOs.tmpdir(), "deepnest-dwg-"));
  const inDir = pathMod.join(base, "in");
  const outDir = pathMod.join(base, "out");
  fs.mkdirSync(inDir);
  fs.mkdirSync(outDir);
  const name = safeName(pathMod.basename(dwgPath));
  const inFile = pathMod.join(inDir, name);
  try {
    fs.copyFileSync(dwgPath, inFile);
    let ran;
    if (found.kind === "libredwg") {
      const outFile = pathMod.join(outDir, name.replace(/\.dwg$/i, ".dxf"));
      ran = await runCommand(spawn, found.bin, ["-y", "-o", outFile, inFile], ctx.env, timeoutMs);
    } else {
      const args = [inDir, outDir, "ACAD2018", "DXF", "0", "1", name];
      const offscreen = Object.assign({}, ctx.env, { QT_QPA_PLATFORM: "offscreen" });
      const firstEnv = ctx.platform === "linux" ? offscreen : ctx.env;
      ran = await runCommand(spawn, found.bin, args, firstEnv, timeoutMs);
      const xvfb = findXvfb(ctx);
      if (!ran.timedOut && ran.code !== 0 && ctx.platform === "linux" && xvfb) {
        const displayEnv = envWithout("QT_QPA_PLATFORM", ctx.env);
        ran = await runCommand(spawn, xvfb, ["-a", found.bin].concat(args), displayEnv, timeoutMs);
      }
    }
    if (ran.timedOut || ran.code !== 0 || ran.error) {
      return failureMessage(found.kind, ran);
    }
    const dxfPath = findDxf(outDir, fs, pathMod);
    if (!dxfPath) {
      const nameLabel = found.kind === "libredwg" ? "LibreDWG dwg2dxf" : "ODA File Converter";
      return { ok: false, code: "no-output", message: nameLabel + " did not write a DXF." };
    }
    const dxf = fs.readFileSync(dxfPath);
    let savedDxf = "";
    let copyError = "";
    if (opts.copyTo) {
      try {
        fs.writeFileSync(opts.copyTo, dxf);
        savedDxf = opts.copyTo;
      } catch (err) {
        copyError = err && err.message ? err.message : "Could not save the DXF copy";
      }
    }
    return {
      ok: true,
      code: "ok",
      dxf: dxf,
      converter: found.bin,
      kind: found.kind,
      savedDxf: savedDxf,
      copyError: copyError,
    };
  } finally {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch (err) {
      void err;
    }
  }
}

module.exports = {
  MISSING_ODA_MESSAGE: MISSING_ODA_MESSAGE,
  findConverter: findConverter,
  convertDwg: convertDwg,
  odaCandidates: function (options) { return odaCandidates(context(options)); },
};
