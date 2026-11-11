/**
 * Load the plain Node helpers. The UI bundle is an ES module, so this uses
 * Electron's require and looks next to the app, then in the working directory.
 */
declare function require(moduleName: string): unknown;

function loadUtil(filename: string): unknown {
  const nodePath = require("path") as { join: (...parts: string[]) => string };
  const roots: string[] = [];
  try {
    const remote = require("@electron/remote") as { app?: { getAppPath?: () => string } };
    if (remote.app && remote.app.getAppPath) {
      roots.push(remote.app.getAppPath());
    }
  } catch {
    // Not in Electron. The working directory is the checkout.
  }
  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    roots.push(process.cwd());
  }
  let lastError: unknown = new Error("Could not load " + filename);
  for (let i = 0; i < roots.length; i++) {
    try {
      return require(nodePath.join(roots[i], "main", "util", filename));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

export function dxfToSvg(input: string | Buffer): string {
  const api = loadUtil("dxf-to-svg.js") as { dxfToSvg: (value: string | Buffer) => string };
  return api.dxfToSvg(input);
}

export function readableConversionError(err: unknown): string {
  const api = loadUtil("conversion-error.js") as {
    readableConversionError: (value: unknown) => string;
  };
  return api.readableConversionError(err);
}

export function convertDwg(
  dwgPath: string,
  options?: { odaPath?: string; copyTo?: string }
): Promise<{ ok: boolean; dxf?: Buffer; message?: string; code?: string; copyError?: string; savedDxf?: string }> {
  const api = loadUtil("dwg-to-dxf.js") as {
    convertDwg: (
      file: string,
      opts: { odaPath?: string; copyTo?: string }
    ) => Promise<{ ok: boolean; dxf?: Buffer; message?: string; code?: string; copyError?: string; savedDxf?: string }>;
  };
  return api.convertDwg(dwgPath, options || {});
}

export interface WorkFolders {
  noteImport(filePath: string): string;
  dialogFolder(defaultWorkFolder: string): string;
  currentSavePath(defaultWorkFolder: string, extension: string): string;
  convertedDxfPath(directory: string, sourceName: string): string;
}

export function workFolders(): WorkFolders {
  return loadUtil("work-folder.js") as WorkFolders;
}
