/**
 * Sanitize a string for use as a filesystem folder name.
 * Lowercase, replace non-alphanumeric with underscore, collapse runs of underscores.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "unnamed";
}
