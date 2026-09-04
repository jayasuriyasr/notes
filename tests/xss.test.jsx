import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import MarkdownRenderer from '../src/components/markdown/MarkdownRenderer.jsx';

const render = (md) =>
  renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(MarkdownRenderer, { content: md })),
  );

const attacks = [
  ['raw script tag',            '<script>alert(1)</script>'],
  ['img onerror',               '<img src=x onerror="alert(1)">'],
  ['svg onload',                '<svg onload=alert(1)></svg>'],
  ['iframe',                    '<iframe src="https://evil.example"></iframe>'],
  ['javascript: link',          '[click me](javascript:alert(1))'],
  ['JaVaScRiPt: link',          '[click me](JaVaScRiPt:alert(1))'],
  ['data: uri link',            '[click me](data:text/html,<script>alert(1)</script>)'],
  ['vbscript link',             '[click me](vbscript:msgbox(1))'],
  ['data: image',               '![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
  ['html entity script',        '&lt;script&gt;alert(1)&lt;/script&gt;'],
  ['style injection',           '<div style="background:url(javascript:alert(1))">x</div>'],
  ['form + input',              '<form action="https://evil.example"><input name="a"></form>'],
  ['onmouseover in md link',    '[x](https://ok.example "title\\" onmouseover=\\"alert(1)")'],
  ['DOM clobber id',            '# body\n\n## constructor'],
  ['base tag',                  '<base href="https://evil.example/">'],
  ['object/embed',              '<object data="evil.swf"></object><embed src="evil.swf">'],
  ['meta refresh',              '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
  ['link stylesheet',           '<link rel="stylesheet" href="https://evil.example/x.css">'],
];

let failures = 0;
// Only real, unescaped markup counts as a leak. An escaped payload sitting
// inside an attribute value (title="... &quot; onmouseover=&quot;") is inert:
// React escapes attribute values, so it can never break out into markup.
const BAD = /(<script|<iframe|<object|<embed|<form|<base|<meta|<link|\son\w+="|href="javascript:|href="vbscript:|src="data:text\/html)/i;

for (const [name, md] of attacks) {
  const html = render(md);
  const leaked = BAD.test(html);
  if (leaked) failures++;
  console.log(`${leaked ? 'LEAK  ' : 'safe  '} ${name.padEnd(24)} -> ${html.slice(0, 150).replace(/\n/g, ' ')}`);
}

console.log('\n--- legitimate features must still work ---');
const good = render([
  '# Title', '',
  'Text with **bold**, *italic*, `inline code`, ~~strike~~ and a [link](/system-design).',
  '',
  '- [x] done', '- [ ] todo', '',
  '| a | b |', '| --- | ---: |', '| 1 | 2 |', '',
  '> quote', '',
  '```js', 'const bucket = { capacity: 10 };', '```', '',
  '## Token Bucket', '', 'See [above](#token-bucket).',
  '', '![alt text](https://example.com/i.png)',
].join('\n'));

const checks = {
  'heading id prefixed':      /id="user-content-token-bucket"/.test(good),
  'anchor link matches id':   /href="#user-content-token-bucket"/.test(good),
  'gfm table':                /<table>/.test(good),
  'task list checkbox':       /<input[^>]*type="checkbox"/.test(good),
  'strikethrough':            /<del>/.test(good),
  'syntax highlight spans':   /class="hljs-/.test(good),
  'code language class':      /language-js/.test(good),
  'blockquote':               /<blockquote>/.test(good),
  'internal link is SPA':     /href="\/system-design"/.test(good),
  'external img lazy':        /loading="lazy"/.test(good),
  'copy button present':      /Copy code to clipboard/.test(good),
  'table wrapped scrollable': /class="table-scroll"/.test(good),
};
for (const [k, v] of Object.entries(checks)) {
  if (!v) failures++;
  console.log(`${v ? 'ok    ' : 'BROKEN'} ${k}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
