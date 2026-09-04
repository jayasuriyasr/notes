import { defaultSchema } from 'rehype-sanitize';

/**
 * ============================================================
 *  XSS DEFENCE
 * ============================================================
 * Markdown is authored by trusted admins, so this is defence in depth
 * rather than the first line of it — but "trusted" covers pasted content,
 * a compromised admin account, and content imported from elsewhere later,
 * so the sanitiser is not optional.
 *
 * Three layers protect the rendered page:
 *
 *   1. react-markdown does not interpret raw HTML at all unless you add
 *      rehype-raw. We do not. `<script>alert(1)</script>` in a document
 *      is rendered as literal text.
 *   2. react-markdown's default urlTransform strips dangerous URL
 *      protocols, so [x](javascript:alert(1)) becomes an inert link.
 *   3. rehype-sanitize runs LAST in the plugin chain and enforces this
 *      allow-list over the final tree — including anything the other
 *      plugins produced.
 *
 * Ordering note: sanitising last means rehype-highlight's output is also
 * checked, which is why `span` needs an explicit className rule below.
 * Sanitising first would leave highlight output unchecked.
 */

/**
 * hast-util-sanitize rewrites `id` (and `name`, and the aria-*
 * references) with this prefix, so a document cannot define
 * `id="body"` and clobber `document.body`. It is a genuinely useful
 * protection, so we keep it — and pay the price of remembering that the
 * anchor for "## Token Bucket" is `#user-content-token-bucket`, not
 * `#token-bucket`. Both the table of contents and in-document anchor
 * links account for this.
 */
export const HEADING_ID_PREFIX = defaultSchema.clobberPrefix ?? 'user-content-';

const headings = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

export const sanitizeSchema = {
  ...defaultSchema,

  attributes: {
    ...defaultSchema.attributes,

    // rehype-highlight tags every token with `hljs-<token>` on a <span>.
    // The default schema allows no className on span at all, which would
    // silently strip all syntax colouring. The regex keeps the allowance
    // as narrow as the feature needs.
    span: [['className', /^hljs-/]],

    // Keep the fence language (used by rehype-highlight) and the `hljs`
    // marker class it adds to the <code> element.
    code: [['className', /^language-./, 'hljs', 'math-inline', 'math-display']],

    // rehype-slug writes ids here; `id` is already permitted by the
    // schema's '*' rule, so nothing to add — listed for clarity.
    ...Object.fromEntries(
      headings.map((tag) => [tag, [...(defaultSchema.attributes?.[tag] ?? []), 'id']]),
    ),

    img: [...(defaultSchema.attributes?.img ?? []), 'loading', 'decoding'],
  },

  // GFM produces these; the default schema already knows del/input, and
  // the rest are standard flow content.
  tagNames: [...new Set([...defaultSchema.tagNames, 'mark', 'kbd', 'sup', 'sub'])],

  // Unchanged from the default, restated so it is visible in review:
  // relative URLs and #fragments are always allowed; javascript:, data:
  // and vbscript: are not.
  protocols: defaultSchema.protocols,
};
