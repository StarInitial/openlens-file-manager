/**
 * Name search for the current directory listing.
 *
 * The listing of a directory is always fetched in full (`find` + `stat`), so the
 * search box filters client-side: no extra exec round-trip per keystroke, and the
 * matched characters can be highlighted in place.
 */

export interface NameSegment {
  text: string;
  /** True for the part that matched the query. */
  match: boolean;
}

function needleOf(query: string): string {
  return (query ?? "").trim().toLowerCase();
}

/** Case-insensitive substring match on the file name. Empty query matches all. */
export function matchesQuery(name: string, query: string): boolean {
  const needle = needleOf(query);
  if (!needle) return true;
  return (name ?? "").toLowerCase().includes(needle);
}

/** Entries whose name contains `query`; an empty query returns the list untouched. */
export function filterEntries<T extends { name: string }>(entries: T[], query: string): T[] {
  if (!needleOf(query)) return entries;
  return entries.filter((entry) => matchesQuery(entry.name, query));
}

/**
 * Split `name` into alternating plain / matched segments (every occurrence, case
 * insensitive) so the renderer can wrap the hits in `<mark>`.
 */
export function highlightSegments(name: string, query: string): NameSegment[] {
  const text = name ?? "";
  const needle = needleOf(query);
  if (!needle || !text) return [{ text, match: false }];

  const haystack = text.toLowerCase();
  // Lower-casing can change the length for a few exotic code points (İ, ß …);
  // then offsets no longer line up, so report a whole-string match instead of
  // slicing the wrong range.
  if (haystack.length !== text.length) return [{ text, match: haystack.includes(needle) }];

  const segments: NameSegment[] = [];
  let index = 0;
  while (index < text.length) {
    const hit = haystack.indexOf(needle, index);
    if (hit < 0) {
      segments.push({ text: text.slice(index), match: false });
      break;
    }
    if (hit > index) segments.push({ text: text.slice(index, hit), match: false });
    segments.push({ text: text.slice(hit, hit + needle.length), match: true });
    index = hit + needle.length;
  }
  return segments.length > 0 ? segments : [{ text, match: false }];
}
