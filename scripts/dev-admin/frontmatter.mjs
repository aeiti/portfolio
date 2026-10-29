// Frontmatter read/write for src/content/projects/<folder>/index.mdx.
//
// Writes are surgical: the YAML is parsed with `yaml`'s Document API only to
// find where each top-level key's text starts and ends. A save replaces the
// text of the keys whose values changed and nothing else — untouched keys,
// comments, key order, folding and quoting stay byte-identical, and so does
// the MDX body unless it was edited. (Re-stringifying the whole Document is
// not an option: it reflows every folded `>-` synopsis in the repo.)
//
// Every write is verified before it reaches disk: the new file is re-parsed
// and deep-compared with the intended values; any mismatch throws and the
// file is left untouched.

import { parseDocument, Document, isScalar, isSeq, isMap } from 'yaml'

// Schema mirror of src/content.config.ts — keep the two in sync. Order here is
// the order new keys are inserted in (after the nearest preceding key).
export const KEYS = [
  'title', 'discipline', 'year', 'role', 'venue', 'client', 'synopsis',
  'cover', 'coverKind', 'gallery', 'documents', 'consoleFilesAvailable',
  'console', 'featured', 'publishedAt', 'draft', 'credits',
]
export const ENUMS = {
  discipline: ['concert', 'theatre', 'corporate-event', 'circus'],
  coverKind: ['photo', 'plot'],
  console: ['eos', 'element', 'grandma2'],
}
export const DEFAULTS = {
  credits: [], coverKind: 'photo', gallery: [], documents: [],
  consoleFilesAvailable: false, console: 'eos', featured: false, draft: false,
}
const OPTIONAL = new Set(['venue', 'client', 'cover', ...Object.keys(DEFAULTS)])

const FM_RE = /^---\r?\n([\s\S]*?\r?\n)?---(\r?\n|$)/

export function splitFile(src) {
  const m = src.match(FM_RE)
  if (!m) throw new Error('no YAML frontmatter block at top of file')
  return { fm: m[1] ?? '', head: src.slice(0, m[0].length), body: src.slice(m[0].length), fmStart: 4 }
}

export function parseFrontmatter(fm) {
  const doc = parseDocument(fm)
  if (doc.errors.length) throw new Error(`YAML error: ${doc.errors[0].message}`)
  if (doc.contents && !isMap(doc.contents)) throw new Error('frontmatter is not a mapping')
  return doc
}

export function readProject(src) {
  const { fm, body } = splitFile(src)
  const doc = parseFrontmatter(fm)
  return { data: doc.toJS() ?? {}, body }
}

// ---- validation -------------------------------------------------------------

const isStr = (v) => typeof v === 'string'
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Returns a list of error strings ([] = valid). `imageExists(relPath)` checks
// that a ./images/… reference resolves inside the project folder, mirroring
// Astro's image() which fails the build on a missing file.
export function validate(data, imageExists = () => true) {
  const errs = []
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['frontmatter must be an object']
  for (const k of Object.keys(data)) if (!KEYS.includes(k)) errs.push(`unknown key "${k}"`)
  for (const k of KEYS) {
    if (!OPTIONAL.has(k) && data[k] === undefined) errs.push(`${k} is required`)
  }
  const v = data
  if (v.title !== undefined && (!isStr(v.title) || !v.title.trim())) errs.push('title must be a non-empty string')
  if (v.role !== undefined && (!isStr(v.role) || !v.role.trim())) errs.push('role must be a non-empty string')
  if (v.synopsis !== undefined && !isStr(v.synopsis)) errs.push('synopsis must be a string')
  for (const k of ['venue', 'client']) if (v[k] !== undefined && !isStr(v[k])) errs.push(`${k} must be a string`)
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (v[k] !== undefined && !allowed.includes(v[k])) errs.push(`${k} must be one of ${allowed.join(' | ')}`)
  }
  if (v.year !== undefined && !(Number.isInteger(v.year) && v.year >= 1990 && v.year <= 2100)) {
    errs.push('year must be an integer 1990–2100')
  }
  if (v.publishedAt !== undefined) {
    const ok = isStr(v.publishedAt) && DATE_RE.test(v.publishedAt) &&
      !Number.isNaN(Date.parse(v.publishedAt)) &&
      new Date(v.publishedAt).toISOString().slice(0, 10) === v.publishedAt
    if (!ok) errs.push('publishedAt must be a real date, YYYY-MM-DD')
  }
  for (const k of ['consoleFilesAvailable', 'featured', 'draft']) {
    if (v[k] !== undefined && typeof v[k] !== 'boolean') errs.push(`${k} must be true/false`)
  }
  if (v.credits !== undefined) {
    if (!Array.isArray(v.credits)) errs.push('credits must be a list')
    else v.credits.forEach((c, i) => {
      if (!c || !isStr(c.role) || !isStr(c.name) || Object.keys(c).some((x) => x !== 'role' && x !== 'name')) {
        errs.push(`credits[${i}] must be { role, name } strings`)
      }
    })
  }
  if (v.documents !== undefined) {
    if (!Array.isArray(v.documents)) errs.push('documents must be a list')
    else v.documents.forEach((d, i) => {
      if (!d || !isStr(d.label) || !isStr(d.file) || Object.keys(d).some((x) => x !== 'label' && x !== 'file')) {
        errs.push(`documents[${i}] must be { label, file } strings`)
      }
    })
  }
  if (v.cover !== undefined) {
    if (!isStr(v.cover) || !v.cover) errs.push('cover must be an image path (omit it for none)')
    else if (!imageExists(v.cover)) errs.push(`cover image not found: ${v.cover}`)
  }
  if (v.gallery !== undefined) {
    if (!Array.isArray(v.gallery)) errs.push('gallery must be a list')
    else v.gallery.forEach((g, i) => {
      if (!isStr(g) || !g) errs.push(`gallery[${i}] must be an image path`)
      else if (!imageExists(g)) errs.push(`gallery image not found: ${g}`)
    })
  }
  return errs
}

// ---- write ------------------------------------------------------------------

function canon(v) {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = canon(v[k])
    return o
  }
  return v
}
export const deepEqual = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))

// [start, end) of a top-level pair's text, end including its final newline.
function pairSpan(fm, pair) {
  const start = fm.lastIndexOf('\n', pair.key.range[0] - 1) + 1
  const v = pair.value
  let e = v && v.range ? Math.max(v.range[1], pair.key.range[1]) : pair.key.range[1]
  // An inline comment after the value belongs to this pair.
  if (v && v.range && v.range[2] > e && !fm.slice(e, v.range[2]).includes('\n')) e = v.range[2]
  if (e > 0 && fm[e - 1] === '\n') return [start, e]
  const nl = fm.indexOf('\n', e)
  return [start, nl === -1 ? fm.length : nl + 1]
}

// Text for one `key: value` pair, keeping the old node's scalar style
// (folded synopsis, quoted strings, flow-style lists) where it still applies.
function renderPair(key, value, oldNode) {
  const doc = new Document({})
  let node = doc.createNode(value)
  if (oldNode && isScalar(oldNode) && isScalar(node) && typeof value === 'string') {
    node.type = oldNode.type
  }
  // An empty `[]` that gains items goes block-style (the repo's convention);
  // a list that was already written flow-style with items stays flow.
  if (oldNode && (isSeq(oldNode) || isMap(oldNode)) && oldNode.flow && oldNode.items.length &&
      (isSeq(node) || isMap(node))) {
    node.flow = true
  }
  if (oldNode && isSeq(oldNode) && isSeq(node)) {
    node.items.forEach((item, i) => {
      const o = oldNode.items[i]
      if (o && isMap(o) && isMap(item) && o.flow) item.flow = true
    })
  }
  if (oldNode?.comment) node.comment = oldNode.comment
  doc.contents.set(doc.createNode(key), node)
  // Only block scalars (`>-` synopses) wrap, at the repo's ~72 columns; a
  // long role or title stays on one line rather than folding mid-value.
  const block = isScalar(node) && (node.type === 'BLOCK_FOLDED' || node.type === 'BLOCK_LITERAL')
  let out = doc.toString({ lineWidth: block ? 72 : 0, minContentWidth: 20 })
  if (!out.endsWith('\n')) out += '\n'
  return out
}

// Build the new file text for `data` + `body` against the current source.
// Returns { next, changed } — `changed` lists top-level keys rewritten.
export function buildFile(src, data, body) {
  const { fm, body: oldBody } = splitFile(src)
  const doc = parseFrontmatter(fm)
  const current = doc.toJS() ?? {}
  const pairs = isMap(doc.contents) ? doc.contents.items : []
  const byKey = new Map(pairs.map((p) => [String(p.key?.value ?? p.key), p]))

  // Edits as [start, end, text], applied right-to-left so offsets stay valid.
  const edits = []
  const changed = []
  for (const key of new Set([...Object.keys(current), ...Object.keys(data)])) {
    const has = Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined
    if (has && deepEqual(current[key], data[key])) continue
    if (!has && current[key] === undefined && !byKey.has(key)) continue
    changed.push(key)
    const pair = byKey.get(key)
    if (pair) {
      const [s, e] = pairSpan(fm, pair)
      edits.push([s, e, has ? renderPair(key, data[key], pair.value) : ''])
    } else {
      // New key: after the nearest preceding schema key that exists, else end.
      let at = fm.length
      const idx = KEYS.indexOf(key)
      for (let i = idx - 1; i >= 0; i--) {
        const prev = byKey.get(KEYS[i])
        if (prev) { at = pairSpan(fm, prev)[1]; break }
      }
      if (at === fm.length && fm && !fm.endsWith('\n')) edits.push([at, at, '\n'])
      edits.push([at, at, renderPair(key, data[key], null)])
    }
  }
  edits.sort((a, b) => b[0] - a[0] || b[1] - a[1])
  let nextFm = fm
  for (const [s, e, t] of edits) nextFm = nextFm.slice(0, s) + t + nextFm.slice(e)

  const nextBody = body === undefined ? oldBody : body
  const head = src.match(FM_RE)[0]
  // Rebuild with the original delimiters and line endings.
  const open = head.slice(0, head.indexOf('\n') + 1)
  const closeIdx = head.lastIndexOf('---')
  const close = head.slice(closeIdx)
  const next = open + nextFm + close + nextBody

  // Verify: re-parse what we are about to write and compare to intent.
  const re = splitFile(next)
  const reDoc = parseFrontmatter(re.fm)
  const want = {}
  for (const k of Object.keys(data)) if (data[k] !== undefined) want[k] = data[k]
  if (!deepEqual(reDoc.toJS() ?? {}, want)) {
    throw new Error('round-trip mismatch: re-parsed frontmatter differs from the intended values — file left untouched')
  }
  if (re.body !== nextBody) throw new Error('round-trip mismatch in MDX body — file left untouched')
  // Untouched keys must be byte-identical to before.
  for (const p of pairs) {
    const k = String(p.key?.value ?? p.key)
    if (changed.includes(k)) continue
    const [s, e] = pairSpan(fm, p)
    if (!re.fm.includes(fm.slice(s, e))) {
      throw new Error(`round-trip mismatch: untouched key "${k}" changed — file left untouched`)
    }
  }
  return { next, changed, bodyChanged: nextBody !== oldBody }
}

// New-project file. Starts as a draft so nothing goes live by accident; the
// title goes through the YAML stringifier so quotes/colons are escaped.
export function template({ title, discipline, year, publishedAt }) {
  return [
    '---',
    new Document({ title }).toString().trimEnd(),
    `discipline: ${discipline}`,
    `year: ${year}`,
    'role: Lighting Programmer',
    'venue: ""',
    'client: ""',
    'synopsis: >-',
    '  One- to three-sentence summary.',
    'coverKind: photo',
    'gallery: []',
    'documents: []',
    'consoleFilesAvailable: false',
    'featured: false',
    `publishedAt: ${publishedAt}`,
    'draft: true',
    'credits: []',
    '---',
    '',
    '',
  ].join('\n')
}
