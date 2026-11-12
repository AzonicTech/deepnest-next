/**
 * Short text for a failed online conversion.
 * Never includes the uploaded file. JSON.stringify(err) used to dump the
 * multipart body as a comma-separated byte list into the red status line.
 */
"use strict";

function clip(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > 160 ? clean.slice(0, 160) + "…" : clean;
}

function looksLikePayload(text) {
  if (!text) return false;
  if (text.length > 180) return true;
  if (text.indexOf("fileUpload") !== -1) return true;
  return /(?:\d{1,3},\s*){8,}/.test(text);
}

function readableConversionError(err) {
  const fallback = "Could not contact file conversion server.";
  if (!err || typeof err !== "object") {
    const text = clip(err);
    return text && !looksLikePayload(text) ? fallback.slice(0, -1) + ": " + text + "." : fallback;
  }
  const response = err.response;
  const status = response && response.status;
  let detail = "";
  const data = response && response.data;
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (trimmed.charAt(0) === "{" && trimmed.indexOf("error_id") !== -1) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && parsed.error_id) detail = String(parsed.error_id);
      } catch (parseErr) {
        void parseErr;
      }
    } else if (!looksLikePayload(trimmed)) {
      detail = clip(trimmed);
    }
  } else if (data && typeof data === "object" && data.error_id) {
    detail = String(data.error_id);
  }
  if (status) {
    return detail
      ? "Could not contact file conversion server (HTTP " + status + ": " + detail + ")."
      : "Could not contact file conversion server (HTTP " + status + ").";
  }
  const message = typeof err.message === "string" ? err.message : "";
  if (message && !looksLikePayload(message)) {
    return "Could not contact file conversion server: " + clip(message) + ".";
  }
  return fallback;
}

module.exports = {
  readableConversionError: readableConversionError,
};
