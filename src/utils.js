// Pure utility functions with no dependencies on app state or Firebase.

export function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

export function escapeHtml(str) {
  const safeStr = String(str ?? "");
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  return safeStr.replace(/[&<>"']/g, c => map[c]);
}

export function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shiftLocalDate(dateStr, daysToAdd) {
  const date = new Date(dateStr + "T00:00:00");
  date.setDate(date.getDate() + daysToAdd);
  return formatLocalDate(date);
}

export function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
