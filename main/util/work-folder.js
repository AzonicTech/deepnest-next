/**
 * Where file dialogs open, and where a DWG conversion may leave a DXF.
 *
 * The default work folder is a saved setting. The job folder is the directory
 * of the most recent import and lasts for this session only. A missing folder
 * falls through to the next choice, then to the home directory.
 */
"use strict";

const nodeFs = require("fs");
const nodeOs = require("os");
const nodePath = require("path");

let sessionFolder = "";
let importStems = [];

function resetSession() {
  sessionFolder = "";
  importStems = [];
}

function noteImport(filePath) {
  if (!filePath) return sessionFolder;
  const dir = nodePath.dirname(String(filePath));
  if (dir && dir !== ".") sessionFolder = dir;
  const base = nodePath.basename(String(filePath));
  const stem = base.replace(/\.[^.]+$/, "") || base;
  const clean = stem.replace(/[\\/:*?"<>|]/g, "-").trim();
  if (clean) importStems.push(clean);
  return sessionFolder;
}

function getSessionFolder() {
  return sessionFolder;
}

function getImportStems() {
  return importStems.slice();
}

function resolveWorkFolder(options) {
  const opts = options || {};
  const exists = opts.existsSync || function () { return false; };
  const session = opts.sessionFolder != null ? opts.sessionFolder : sessionFolder;
  const configured = String(opts.defaultWorkFolder || "").trim();
  const home = opts.home != null ? opts.home : "";
  const candidates = [session, configured, home];
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i] && exists(candidates[i])) return candidates[i];
  }
  return "";
}

function dialogFolder(defaultWorkFolder) {
  return resolveWorkFolder({
    defaultWorkFolder: defaultWorkFolder,
    home: nodeOs.homedir(),
    existsSync: nodeFs.existsSync,
  });
}

function exportStem(stems) {
  const clean = (stems || []).filter(function (stem) { return stem; });
  if (!clean.length) return "nest";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return clean[0] + "-" + clean[1];
  return clean[0] + "-and-" + (clean.length - 1) + "-more";
}

function saveDialogPath(folder, stems, extension) {
  const ext = String(extension || "svg").replace(/^\./, "");
  const name = exportStem(stems) + "." + ext;
  if (!folder) return name;
  return nodePath.join(folder, name);
}

function currentSavePath(defaultWorkFolder, extension) {
  return saveDialogPath(dialogFolder(defaultWorkFolder), importStems, extension);
}

function nextAvailable(directory, filename, existsSync) {
  const exists = existsSync || nodeFs.existsSync;
  const ext = nodePath.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = nodePath.join(directory, filename);
  let n = 2;
  while (exists(candidate) && n < 1000) {
    candidate = nodePath.join(directory, stem + "-" + n + ext);
    n += 1;
  }
  return candidate;
}

function convertedDxfPath(directory, sourceName, existsSync) {
  const stem = nodePath.basename(String(sourceName)).replace(/\.[^.]+$/, "") || "drawing";
  return nextAvailable(directory, stem + ".converted.dxf", existsSync);
}

module.exports = {
  resetSession: resetSession,
  noteImport: noteImport,
  getSessionFolder: getSessionFolder,
  getImportStems: getImportStems,
  resolveWorkFolder: resolveWorkFolder,
  dialogFolder: dialogFolder,
  saveDialogPath: saveDialogPath,
  currentSavePath: currentSavePath,
  convertedDxfPath: convertedDxfPath,
};
