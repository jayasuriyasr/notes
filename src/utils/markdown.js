import { slugify } from './slug';

/**
 * Pull ## / ### headings out of a Markdown source for the on-page
 * table of contents.
 *
 * Deliberately a regex and not a full parse: this runs on every render of
 * a page and only needs heading text. Fenced code blocks are stripped
 * first so a `# comment` inside a shell example never becomes a heading.
 *
 * The generated ids match rehype-slug's algorithm (github-slugger), which
 * is what actually renders the anchors, so the links line up.
 */
export function extractHeadings(markdown = '', { min = 2, max = 3 } = {}) {
  const withoutCode = markdown.replace(/^```[\s\S]*?^```/gm, '').replace(/^~~~[\s\S]*?^~~~/gm, '');
  const headings = [];
  const seen = new Map();

  const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;
  let match;
  while ((match = re.exec(withoutCode)) !== null) {
    const level = match[1].length;
    if (level < min || level > max) continue;

    const text = match[2].replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
    let id = slugify(text);
    if (!id) continue;

    // github-slugger appends -1, -2 ... to repeats
    if (seen.has(id)) {
      const n = seen.get(id) + 1;
      seen.set(id, n);
      id = `${id}-${n}`;
    } else {
      seen.set(id, 0);
    }

    headings.push({ level, text, id });
  }
  return headings;
}

/**
 * Does this document open with its own level-1 heading?
 *
 * Most pages start with `# Title`, and rendering the stored title above
 * that would duplicate it. A page that does not — someone wrote a
 * paragraph and saved — would otherwise render with no visible title at
 * all, leaving the breadcrumb as the only clue about what you are
 * reading. Checking lets the page supply one only when it is missing.
 */
export function startsWithH1(markdown = '') {
  const firstLine = String(markdown)
    .replace(/^---[\s\S]*?---\s*/, '')     // front matter
    .split('\n')
    .find((line) => line.trim().length > 0);
  return /^#\s+\S/.test(firstLine ?? '');
}

/**
 * Plain-text summary for <meta name="description"> when an author has not
 * written an explicit excerpt. Strips the Markdown rather than rendering
 * it, because a meta description containing "##" looks broken in results.
 */
export function deriveExcerpt(markdown = '', limit = 160) {
  const text = markdown
    .replace(/^---[\s\S]*?---/, '')            // front matter
    .replace(/^```[\s\S]*?^```/gm, '')          // fenced code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')       // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')    // links -> text
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, '')      // headings
    .replace(/^\s{0,3}>\s?/gm, '')              // blockquote markers
    .replace(/^\s{0,3}([*+-]|\d+\.)\s+/gm, '')  // list markers
    .replace(/[*_~`]/g, '')                     // emphasis marks
    .replace(/\|/g, ' ')                        // table pipes
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 60 ? lastSpace : limit).trimEnd()}…`;
}

/**
 * Split a ts_headline result on the sentinels chosen in search_topics().
 *
 * We ask Postgres for `<<term>>` rather than `<mark>term</mark>` on
 * purpose: ts_headline does NOT escape the document it highlights, so
 * asking for HTML and injecting it would hand raw page content straight
 * to the DOM. Returning segments lets React build real <mark> elements
 * with no HTML interpolation anywhere in the path.
 */
export function parseHighlight(headline = '') {
  return String(headline)
    .split(/(<<[^>]*?>>)/g)
    .filter(Boolean)
    .map((chunk) =>
      chunk.startsWith('<<') && chunk.endsWith('>>')
        ? { text: chunk.slice(2, -2), highlight: true }
        : { text: chunk, highlight: false },
    );
}
