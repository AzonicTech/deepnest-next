/**
 * Export Service
 * Handles SVG/DXF/JSON export functionality for nesting results
 * Manages file save dialogs, format conversion, and file writing
 */

import type {
  UIConfig,
  DeepNestInstance,
  SelectableNestingResult,
  Part,
  SvgParserInstance,
} from "../types/index.js";
import { DEFAULT_CONVERSION_SERVER } from "../types/index.js";
import { message } from "../utils/ui-helpers.js";
import { readableConversionError } from "../utils/local-modules.js";

/**
 * File filter options for the save dialog
 */
interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * Save dialog options
 */
interface SaveDialogOptions {
  title: string;
  filters: FileFilter[];
}

/**
 * Dialog interface for Electron's dialog module
 */
interface ElectronDialog {
  showSaveDialogSync(options: SaveDialogOptions): string | undefined;
}

/**
 * Remote interface for Electron's remote module
 */
interface ElectronRemote {
  getGlobal(name: string): string | undefined;
}

/**
 * File system interface for Node.js fs module
 */
interface FileSystem {
  writeFileSync(path: string, data: string): void;
}

/**
 * Axios-like HTTP client interface
 */
interface HttpClient {
  post(
    url: string,
    data: Buffer,
    options: { headers: Record<string, string>; responseType: string }
  ): Promise<{ data: string }>;
}

/**
 * FormData-like interface for file upload
 */
interface FormDataLike {
  append(
    name: string,
    value: Buffer | string,
    options?: { filename?: string; contentType?: string }
  ): void;
  getBuffer(): Buffer;
  getHeaders(): Record<string, string>;
}

/**
 * FormData constructor interface
 */
interface FormDataConstructor {
  new (): FormDataLike;
}

/**
 * Config getter interface
 */
interface ConfigGetter {
  getSync<K extends keyof UIConfig>(key?: K): K extends keyof UIConfig ? UIConfig[K] : UIConfig;
}

/**
 * Placement within a sheet (matches index.d.ts SheetPlacement)
 */
interface PartPlacement {
  id: number;
  filename: string;
  source: number;
  x: number;
  y: number;
  rotation: number;
}

interface ExportGeometryApi {
  placePath(
    d: string,
    placement: { x: number; y: number; rotation: number },
    tolerance: number
  ): { d: string; subpaths: unknown[]; segments: number; sourceSegments: number };
  placePolyline(
    points: { x: number; y: number }[],
    closed: boolean,
    placement: { x: number; y: number; rotation: number },
    tolerance: number
  ): { d: string; subpaths: unknown[]; segments: number; sourceSegments: number };
  toDxf(subpaths: unknown[], scale: number, units?: string): string;
}

declare global {
  interface Window {
    ExportGeometry?: ExportGeometryApi;
  }
}

/**
 * Sheet with placements (matches NestingResult.placements structure)
 */
interface SheetGroup {
  sheet: number;
  sheetid: number;
  sheetplacements: PartPlacement[];
}

/**
 * Export button element interface
 */
interface ExportButtonElement extends HTMLElement {
  className: string;
}

/**
 * Export options for SVG generation
 */
export interface ExportOptions {
  /** Whether this export is for DXF conversion (affects scaling) */
  forDxfConversion?: boolean;
}

/**
 * Export file formats
 */
export type ExportFormat = "svg" | "dxf" | "json";

/**
 * File filters for export dialogs
 */
const SVG_FILE_FILTERS: FileFilter[] = [
  { name: "SVG", extensions: ["svg"] }
];

const DXF_FILE_FILTERS: FileFilter[] = [
  { name: "DXF/DWG", extensions: ["dxf", "dwg"] }
];

/**
 * Export Service class
 * Handles export operations for nesting results to various formats
 * Follows the pattern from main/deepnest.js ES6 class structure
 */
export class ExportService {
  /** Electron dialog for file save dialogs */
  private dialog: ElectronDialog | null = null;

  /** Electron remote for accessing global variables */
  private remote: ElectronRemote | null = null;

  /** Node.js file system module */
  private fs: FileSystem | null = null;

  /** HTTP client for conversion requests */
  private httpClient: HttpClient | null = null;

  /** FormData constructor for file upload */
  private FormData: FormDataConstructor | null = null;

  /** Configuration getter */
  private config: ConfigGetter | null = null;

  /** DeepNest instance for accessing parts and nests */
  private deepNest: DeepNestInstance | null = null;

  /** Export button element for spinner state */
  private exportButton: ExportButtonElement | null = null;

  /** Flag to track if export is busy */
  private isExporting = false;

  /**
   * Create a new ExportService instance
   * Dependencies are injected for testability
   */
  constructor(options?: {
    dialog?: ElectronDialog;
    remote?: ElectronRemote;
    fs?: FileSystem;
    httpClient?: HttpClient;
    FormData?: FormDataConstructor;
    config?: ConfigGetter;
    deepNest?: DeepNestInstance;
    svgParser?: SvgParserInstance;
    exportButton?: ExportButtonElement;
  }) {
    if (options) {
      this.dialog = options.dialog || null;
      this.remote = options.remote || null;
      this.fs = options.fs || null;
      this.httpClient = options.httpClient || null;
      this.FormData = options.FormData || null;
      this.config = options.config || null;
      this.deepNest = options.deepNest || null;
      void options.svgParser;
      this.exportButton = options.exportButton || null;
    }
  }

  /**
   * Set the dialog module for file save dialogs
   * @param dialog - Electron dialog module
   */
  setDialog(dialog: ElectronDialog): void {
    this.dialog = dialog;
  }

  /**
   * Set the remote module for accessing globals
   * @param remote - Electron remote module
   */
  setRemote(remote: ElectronRemote): void {
    this.remote = remote;
  }

  /**
   * Set the file system module
   * @param fs - Node.js fs module
   */
  setFileSystem(fs: FileSystem): void {
    this.fs = fs;
  }

  /**
   * Set the HTTP client for conversion requests
   * @param httpClient - HTTP client (e.g., axios)
   */
  setHttpClient(httpClient: HttpClient): void {
    this.httpClient = httpClient;
  }

  /**
   * Set the FormData constructor
   * @param FormData - FormData constructor
   */
  setFormDataConstructor(FormData: FormDataConstructor): void {
    this.FormData = FormData;
  }

  /**
   * Set the configuration getter
   * @param config - Configuration object with getSync method
   */
  setConfig(config: ConfigGetter): void {
    this.config = config;
  }

  /**
   * Set the DeepNest instance
   * @param deepNest - DeepNest instance for accessing parts and nests
   */
  setDeepNest(deepNest: DeepNestInstance): void {
    this.deepNest = deepNest;
  }

  /**
   * Retained for callers. Cut export no longer flattens curves through SvgParser.
   */
  setSvgParser(_svgParser: SvgParserInstance): void {
    void _svgParser;
  }

  /**
   * Set the export button element for spinner state
   * @param button - Export button element
   */
  setExportButton(button: ExportButtonElement): void {
    this.exportButton = button;
  }

  /**
   * Get the conversion server URL from config or use default
   * @returns Conversion server URL
   */
  private getConversionServerUrl(): string {
    if (!this.config) {
      return DEFAULT_CONVERSION_SERVER;
    }

    const configUrl = this.config.getSync("conversionServer");
    return configUrl || DEFAULT_CONVERSION_SERVER;
  }

  /**
   * Get the currently selected nesting result
   * @returns Selected nesting result or null if none selected
   */
  private getSelectedNest(): SelectableNestingResult | null {
    if (!this.deepNest) {
      return null;
    }

    const selected = this.deepNest.nests.filter((n) => n.selected);
    if (selected.length === 0) {
      return null;
    }

    return selected[selected.length - 1];
  }

  /**
   * Show the export button as loading
   */
  private setExportLoading(loading: boolean): void {
    if (this.exportButton) {
      if (loading) {
        this.exportButton.className = "button export spinner";
      } else {
        this.exportButton.className = "button export";
      }
    }
  }

  /**
   * Export the selected nest result to JSON file
   * Saves to the NEST_DIRECTORY as exports.json
   * @returns True if export was successful
   */
  exportToJson(): boolean {
    if (!this.remote || !this.fs || !this.deepNest) {
      return false;
    }

    const nestDirectory = this.remote.getGlobal("NEST_DIRECTORY");
    if (!nestDirectory) {
      return false;
    }

    const filePath = nestDirectory + "exports.json";

    const selected = this.getSelectedNest();
    if (!selected) {
      return false;
    }

    const fileData = JSON.stringify(selected);
    this.fs.writeFileSync(filePath, fileData);

    return true;
  }

  /**
   * Show save dialog and export to SVG
   * @returns True if export was successful
   */
  exportToSvg(): boolean {
    if (!this.dialog || !this.fs) {
      message("Export dependencies not available", true);
      return false;
    }

    let fileName = this.dialog.showSaveDialogSync({
      title: "Export deepnest SVG",
      filters: SVG_FILE_FILTERS,
    });

    if (fileName === undefined) {
      return false;
    }

    // Ensure .svg extension
    if (!fileName.toLowerCase().endsWith(".svg")) {
      fileName = fileName + ".svg";
    }

    const selected = this.getSelectedNest();
    if (!selected) {
      return false;
    }

    const svgContent = this.generateSvgExport(selected);
    this.fs.writeFileSync(fileName, svgContent);

    return true;
  }

  /**
   * Show save dialog and export to DXF via conversion server
   * @returns Promise that resolves to true if export was successful
   */
  async exportToDxf(): Promise<boolean> {
    if (!this.dialog || !this.fs) {
      message("Export dependencies not available", true);
      return false;
    }

    let fileName = this.dialog.showSaveDialogSync({
      title: "Export deepnest DXF",
      filters: DXF_FILE_FILTERS,
    });

    if (fileName === undefined) {
      return false;
    }

    // Ensure .dxf or .dwg extension
    if (!fileName.toLowerCase().endsWith(".dxf") && !fileName.toLowerCase().endsWith(".dwg")) {
      fileName = fileName + ".dxf";
    }

    const selected = this.getSelectedNest();
    if (!selected) {
      return false;
    }

    // DXF is written here so arcs stay arcs and no server is contacted.
    if (fileName.toLowerCase().endsWith(".dxf")) {
      if (!this.geometry()) {
        message("Export geometry is not loaded", true);
        return false;
      }
      this.fs.writeFileSync(fileName, this.dxfForNest(selected));
      return true;
    }

    if (this.config?.getSync("useOnlineConverter") !== true) {
      message(
        "DWG export uses the online converter, and that option is off. Save as DXF to write the file on this computer.",
        true
      );
      return false;
    }

    if (!this.httpClient || !this.FormData) {
      message("Export dependencies not available", true);
      return false;
    }

    const url = this.getConversionServerUrl();
    this.setExportLoading(true);

    try {
      // Generate SVG with DXF scaling
      const svgContent = this.generateSvgExport(selected, { forDxfConversion: true });

      const formData = new this.FormData();
      formData.append("fileUpload", Buffer.from(svgContent), {
        filename: "deepnest.svg",
        contentType: "image/svg+xml",
      });
      formData.append("format", "dxf");

      const response = await this.httpClient.post(url, formData.getBuffer(), {
        headers: formData.getHeaders(),
        responseType: "text",
      });

      const body = response.data;

      // Check for error responses
      if (body.substring(0, 5) === "error") {
        message(body, true);
        return false;
      }

      if (body.includes('"error"') && body.includes('"error_id"')) {
        const jsonErr = JSON.parse(body) as { error_id: string };
        message(
          `There was an Error while converting: ${jsonErr.error_id}<br>Please use this code to open an issue on github.com/deepnest-next/deepnest`,
          true
        );
        return false;
      }

      this.fs.writeFileSync(fileName, body);
      return true;
    } catch (err) {
      const error = err as { response?: { data: string }; message: string };
      const errorData = error.response?.data || error.message;

      if (
        typeof errorData === "string" &&
        errorData.includes('"error"') &&
        errorData.includes('"error_id"')
      ) {
        const jsonErr = JSON.parse(errorData) as { error_id: string };
        message(
          `There was an Error while converting: ${jsonErr.error_id}<br>Please use this code to open an issue on github.com/deepnest-next/deepnest`,
          true
        );
      } else {
        message(readableConversionError(err), true);
      }
      return false;
    } finally {
      this.setExportLoading(false);
    }
  }

  /**
   * Generate SVG content from a nesting result
   * Core function that builds the SVG document from placements
   * @param nestResult - The nesting result to export
   * @param options - Export options
   * @returns SVG content as string
   */
  generateSvgExport(
    nestResult: SelectableNestingResult,
    options: ExportOptions = {}
  ): string {
    if (!this.deepNest || !this.config) {
      throw new Error("DeepNest or config not available");
    }

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    let svgWidth = 0;
    let svgHeight = 0;
    let sheetNumber = 0;

    const parts = this.deepNest.parts;
    const exportWithSheetBoundaries = !!this.config.getSync("exportWithSheetBoundboarders");
    const exportWithSheetsSpace = !!this.config.getSync("exportWithSheetsSpace");
    const exportWithSheetsSpaceValue = this.config.getSync("exportWithSheetsSpaceValue") || 0;

    // Process each sheet placement
    (nestResult.placements as SheetGroup[]).forEach((s) => {
      sheetNumber++;

      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      svg.appendChild(group);

      // Add sheet boundary if configured
      if (exportWithSheetBoundaries) {
        this.addSheetBoundary(group, parts[s.sheet]);
      }

      const sheetBounds = parts[s.sheet].bounds;

      // Position the group
      group.setAttribute(
        "transform",
        `translate(${-sheetBounds.x} ${svgHeight - sheetBounds.y})`
      );

      // Track maximum width
      if (svgWidth < sheetBounds.width) {
        svgWidth = sheetBounds.width;
      }

      // Add each part placement. Curves stay real curves; the placement
      // rotate-then-translate is baked into the path so a CAM program does
      // not resample the group transform into line segments.
      s.sheetplacements.forEach((p) => {
        const part = parts[p.source];
        const partGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
        partGroup.setAttribute("id", String(p.id));

        part.svgelements.forEach((e) => {
          partGroup.appendChild(this.placedElement(e, p));
        });

        group.appendChild(partGroup);
      });

      // Update height for next sheet
      svgHeight += sheetBounds.height;

      // Add spacing between sheets (except after last sheet)
      if (exportWithSheetsSpace && sheetNumber < (nestResult.placements as SheetGroup[]).length) {
        svgHeight += exportWithSheetsSpaceValue;
      }
    });

    // Calculate final dimensions with scaling
    this.applyDimensions(svg, svgWidth, svgHeight, options);

    // Shared-edge merging used to split every contour into one line element
    // per segment. That is the extra motion the cutter stutters on, so the
    // cut file keeps the original curves and simplified polylines instead.

    return new XMLSerializer().serializeToString(svg);
  }

  private exportTolerance(): number {
    const value = Number(this.config?.getSync("exportCurveTolerance"));
    return value > 0 ? value : 0;
  }

  private geometry(): ExportGeometryApi | null {
    return window.ExportGeometry || null;
  }

  private placedElement(source: Element, placement: PartPlacement): Element {
    const node = source.cloneNode(false) as Element;
    if (node.tagName === "image") {
      const relPath = node.getAttribute("data-href");
      if (relPath) node.setAttribute("href", relPath);
      node.removeAttribute("data-href");
    }

    const api = this.geometry();
    const tag = node.tagName.toLowerCase();
    const transform = `translate(${placement.x} ${placement.y}) rotate(${placement.rotation})`;
    if (!api) {
      node.setAttribute("transform", transform);
      return node;
    }

    if (tag === "path") {
      const placed = api.placePath(node.getAttribute("d") || "", placement, this.exportTolerance());
      node.setAttribute("d", placed.d);
      node.removeAttribute("transform");
      return node;
    }

    if (tag === "polygon" || tag === "polyline") {
      const points = this.readSvgPoints(node);
      if (points.length) {
        const placed = api.placePolyline(points, tag === "polygon", placement, this.exportTolerance());
        const path = source.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", placed.d);
        path.setAttribute("fill", node.getAttribute("fill") || "none");
        path.setAttribute("stroke", node.getAttribute("stroke") || "#000000");
        return path;
      }
    }

    node.setAttribute("transform", transform);
    return node;
  }

  private readSvgPoints(node: Element): { x: number; y: number }[] {
    const points = (node as SVGPolygonElement).points;
    if (!points) return [];
    const list = [];
    for (let i = 0; i < points.numberOfItems; i++) {
      const point = points.getItem(i);
      list.push({ x: point.x, y: point.y });
    }
    return list;
  }

  /**
   * DXF in sheet units, with arc bulges instead of a line per sample.
   */
  dxfForNest(nestResult: SelectableNestingResult): string {
    if (!this.deepNest || !this.config || !this.geometry()) {
      throw new Error("DXF export is not available");
    }
    const api = this.geometry()!;
    const parts = this.deepNest.parts;
    const subpaths: unknown[] = [];
    let svgHeight = 0;
    const tolerance = this.exportTolerance();
    const placements = nestResult.placements as SheetGroup[];

    placements.forEach((s) => {
      const sheetBounds = parts[s.sheet].bounds;
      s.sheetplacements.forEach((p) => {
        const placement = {
          x: p.x - sheetBounds.x,
          y: p.y + svgHeight - sheetBounds.y,
          rotation: p.rotation,
        };
        parts[p.source].svgelements.forEach((element) => {
          const tag = element.tagName.toLowerCase();
          if (tag === "path") {
            subpaths.push(
              ...api.placePath(element.getAttribute("d") || "", placement, tolerance).subpaths
            );
          } else if (tag === "polygon" || tag === "polyline") {
            const points = this.readSvgPoints(element);
            if (!points.length) return;
            subpaths.push(
              ...api.placePolyline(points, tag === "polygon", placement, tolerance).subpaths
            );
          }
        });
      });
      svgHeight += sheetBounds.height;
    });

    const scale = Number(this.config.getSync("scale")) || 72;
    const units = this.config.getSync("units");
    const factor = units === "mm" ? 25.4 / scale : 1 / scale;
    return api.toDxf(subpaths, factor, units);
  }

  /**
   * Add sheet boundary to a group
   * @param group - SVG group element
   * @param sheetPart - Part representing the sheet
   */
  private addSheetBoundary(group: SVGGElement, sheetPart: Part): void {
    sheetPart.svgelements.forEach((e) => {
      const node = e.cloneNode(false) as SVGElement;
      node.setAttribute("stroke", "#00ff00");
      node.setAttribute("fill", "none");
      group.appendChild(node);
    });
  }

  /**
   * Apply dimensions and viewBox to the SVG element
   * @param svg - SVG element
   * @param width - Content width in SVG units
   * @param height - Content height in SVG units
   * @param options - Export options
   */
  private applyDimensions(
    svg: SVGSVGElement,
    width: number,
    height: number,
    options: ExportOptions
  ): void {
    if (!this.config) {
      return;
    }

    let scale = this.config.getSync("scale");

    // Apply DXF export scale if converting to DXF
    if (options.forDxfConversion) {
      const dxfExportScale = Number(this.config.getSync("dxfExportScale")) || 1;
      scale /= dxfExportScale;
    }

    // Convert scale based on units
    const units = this.config.getSync("units");
    if (units === "mm") {
      scale /= 25.4;
    }

    // Set dimensions with unit suffix
    const unitSuffix = units === "inch" ? "in" : "mm";
    svg.setAttribute("width", `${width / scale}${unitSuffix}`);
    svg.setAttribute("height", `${height / scale}${unitSuffix}`);
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  }

  /**
   * Export to the specified format
   * @param format - Export format (svg, dxf, or json)
   * @returns Promise that resolves to true if export was successful
   */
  async export(format: ExportFormat): Promise<boolean> {
    if (this.isExporting) {
      return false;
    }

    this.isExporting = true;

    try {
      switch (format) {
        case "svg":
          return this.exportToSvg();
        case "dxf":
          return await this.exportToDxf();
        case "json":
          return this.exportToJson();
        default:
          message(`Unsupported export format: ${format}`, true);
          return false;
      }
    } finally {
      this.isExporting = false;
    }
  }

  /**
   * Check if export is currently in progress
   * @returns True if exporting
   */
  isExportInProgress(): boolean {
    return this.isExporting;
  }

  /**
   * Check if there is a selected nest result available for export
   * @returns True if a nest result is selected
   */
  hasSelectedNest(): boolean {
    return this.getSelectedNest() !== null;
  }

  /**
   * Get supported export formats
   * @returns Array of supported format strings
   */
  static getSupportedFormats(): ExportFormat[] {
    return ["svg", "dxf", "json"];
  }

  /**
   * Get file filters for a specific format
   * @param format - Export format
   * @returns Array of file filters
   */
  static getFileFilters(format: ExportFormat): FileFilter[] {
    switch (format) {
      case "svg":
        return [...SVG_FILE_FILTERS];
      case "dxf":
        return [...DXF_FILE_FILTERS];
      default:
        return [];
    }
  }

  /**
   * Create and return a new ExportService instance
   * @param options - Optional configuration options
   * @returns New ExportService instance
   */
  static create(options?: ConstructorParameters<typeof ExportService>[0]): ExportService {
    return new ExportService(options);
  }
}

/**
 * Factory function to create an export service
 * @param options - Optional configuration options
 * @returns New ExportService instance
 */
export function createExportService(
  options?: ConstructorParameters<typeof ExportService>[0]
): ExportService {
  return ExportService.create(options);
}
