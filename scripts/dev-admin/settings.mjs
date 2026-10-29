// Site settings (src/data/site.json): validation, usage and a pure-JS mirror
// of the showcase / résumé ranking, driven entirely by a settings object.
//
// No Node imports: the panel serves this file to the browser too
// (GET <admin>/settings.mjs), so the UI validates and scores with exactly the
// code the server uses. Ranking takes the settings as an argument so the
// Settings tab can preview UNSAVED values (POST /api/settings/preview).
//
// Mirror of src/lib/showcase.ts + src/pages/{index,resume}.astro. With the
// default settings it reproduces the hard-coded rules those files had:
//   roleScore    first roles.tiers regex that matches role.toLowerCase(), else fallbackScore
//   showcase     roleScore + min(gallery, galleryCap) / galleryDivisor
//                + coverKinds[kind].showcaseBonus + recency bonus + featured ? featuredBoost
//   homepage     projects with a cover, by showcase score then publishedAt, first homeCount;
//                the hero is the first heroEligible cover kind among them (else the first)
//   résumé       roleScore ≥ resumeMinScore and a venue or client, newest first, first resumeCount

export const TOP_KEYS = ['identity', 'contact', 'nav', 'disciplines', 'consoles', 'defaults', 'coverKinds', 'roles', 'ranking', 'resume', 'about', 'theme']
export const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const HEX_RE = /^#[0-9a-fA-F]{6}$/
export const ASPECT_RE = /^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/
export const FITS = ['cover', 'contain']
// Project frontmatter key ↔ settings list holding its allowed values.
export const KINDS = { discipline: 'disciplines', console: 'consoles', coverKind: 'coverKinds' }
// Changing these means the résumé PDF (npm run resume:pdf) is stale.
export const RESUME_PATHS = ['resume', 'about', 'identity.resumeTagline']

export const IDENTITY_FIELDS = ['name', 'eyebrow', 'heroTitle', 'heroLede', 'ctaPrimary', 'ctaSecondary', 'resumeTagline', 'seoDescription', 'gaId', 'consoleNote', 'resumePdf']
export const CONTACT_FIELDS = ['email', 'phone', 'linkedin', 'linkedinLabel', 'github', 'location', 'siteLabel']
export const PAGE_DESCRIPTIONS = ['work', 'about', 'contact', 'resume']
export const SEO_MAX = 160

const isStr = (v) => typeof v === 'string'
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isInt = (v) => Number.isInteger(v)

export function canon(v) {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = canon(v[k])
    return o
  }
  return v
}
export const deepEqual = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b))
export const getPath = (o, p) => p.split('.').reduce((x, k) => x?.[k], o)

export function compileTier(match) {
  try { return new RegExp(match, 'i') } catch { return null }
}

// "rgba(255,180,83,.12)" / "#ffb453" / "#ffb45320" → { r, g, b, a } or null.
export function parseColor(s) {
  if (!isStr(s)) return null
  const t = s.trim()
  let m = t.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i)
  if (m) {
    const n = parseInt(m[1], 16)
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) / 255 : 1 }
  }
  m = t.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i)
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number)
    const a = m[4] === undefined ? 1 : Number(m[4])
    if ([r, g, b].some((x) => x > 255) || !(a >= 0 && a <= 1)) return null
    return { r, g, b, a }
  }
  return null
}
// Matches the repo's compact style: rgba(255,180,83,.12)
export function formatRgba({ r, g, b, a }) {
  const al = Math.round(a * 100) / 100
  return `rgba(${r},${g},${b},${al === 1 ? '1' : String(al).replace(/^0(?=\.)/, '')})`
}

// WCAG 2.x relative luminance / contrast ratio for #rrggbb.
export function luminance(hex) {
  const c = parseColor(hex)
  if (!c) return null
  const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}
export function contrast(a, b) {
  const x = luminance(a), y = luminance(b)
  if (x === null || y === null) return null
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// ---- validation --------------------------------------------------------------

// Returns [{ path, msg }] — [] means valid. Paths are dotted ("disciplines.2.key")
// so the UI can put each message next to its field.
export function validateSettings(s) {
  const errs = []
  const err = (path, msg) => errs.push({ path, msg })
  if (!isObj(s)) return [{ path: '', msg: 'settings must be a JSON object' }]
  for (const k of TOP_KEYS) if (s[k] === undefined) err(k, `${k} is missing`)

  const str = (o, base, k, { required = false } = {}) => {
    const v = o?.[k]
    if (!isStr(v)) err(`${base}.${k}`, `${k} must be a string`)
    else if (required && !v.trim()) err(`${base}.${k}`, `${k} is required`)
  }
  const int = (o, base, k, { min = -Infinity, max = Infinity } = {}) => {
    const v = o?.[k]
    if (!isInt(v)) err(`${base}.${k}`, `${k} must be a whole number`)
    else if (v < min || v > max) err(`${base}.${k}`, `${k} must be ${max === Infinity ? `≥ ${min}` : `${min}–${max}`}`)
  }
  const strList = (o, base, k, { unique = false, nonEmpty = true } = {}) => {
    const v = o?.[k]
    if (!Array.isArray(v)) { err(`${base}.${k}`, `${k} must be a list`); return }
    const seen = new Map()
    v.forEach((x, i) => {
      if (!isStr(x)) return err(`${base}.${k}.${i}`, 'must be text')
      if (nonEmpty && !x.trim()) return err(`${base}.${k}.${i}`, 'empty entry')
      const n = x.trim().toLowerCase()
      if (unique && seen.has(n)) err(`${base}.${k}.${i}`, `duplicate of #${seen.get(n) + 1}`)
      else seen.set(n, i)
    })
  }

  const id = s.identity
  if (isObj(id)) {
    for (const k of IDENTITY_FIELDS) str(id, 'identity', k, { required: ['name', 'heroTitle', 'ctaPrimary', 'resumePdf'].includes(k) })
    if (isStr(id.gaId) && id.gaId && !/^G-[A-Z0-9]+$/.test(id.gaId)) err('identity.gaId', 'GA id looks like G-XXXXXXXXXX (or leave empty)')
    if (isStr(id.resumePdf) && id.resumePdf && !/^[\w.-]+\.pdf$/.test(id.resumePdf)) err('identity.resumePdf', 'a file name ending in .pdf')
    if (isObj(id.closingCta)) for (const k of ['title', 'text', 'button']) str(id.closingCta, 'identity.closingCta', k)
    else err('identity.closingCta', 'closingCta must be { title, text, button }')
    if (isObj(id.pageDescriptions)) for (const k of PAGE_DESCRIPTIONS) str(id.pageDescriptions, 'identity.pageDescriptions', k)
    else err('identity.pageDescriptions', 'pageDescriptions must be { work, about, contact, resume }')
    if (id.ogImage !== null && !isStr(id.ogImage)) err('identity.ogImage', 'ogImage must be a path or null')
    else if (isStr(id.ogImage) && !id.ogImage.trim()) err('identity.ogImage', 'use null (clear the field) for no image')
  } else if (id !== undefined) err('identity', 'identity must be an object')

  const c = s.contact
  if (isObj(c)) {
    for (const k of CONTACT_FIELDS) str(c, 'contact', k)
    if (isStr(c.email) && c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) err('contact.email', 'not an email address')
    for (const k of ['linkedin', 'github']) if (isStr(c[k]) && c[k] && !/^https:\/\//.test(c[k])) err(`contact.${k}`, 'must start with https://')
  } else if (c !== undefined) err('contact', 'contact must be an object')

  if (Array.isArray(s.nav)) {
    s.nav.forEach((n, i) => {
      if (!isObj(n)) return err(`nav.${i}`, 'must be { label, href }')
      str(n, `nav.${i}`, 'label', { required: true })
      if (!isStr(n.href) || !/^(\/|https?:\/\/)/.test(n.href)) err(`nav.${i}.href`, 'href must start with / (relative to the site base) or http(s)://')
    })
  } else if (s.nav !== undefined) err('nav', 'nav must be a list')

  // Keyed option lists.
  const keyed = (list, extra) => {
    const arr = s[list]
    if (!Array.isArray(arr)) { if (arr !== undefined) err(list, `${list} must be a list`); return }
    if (!arr.length) err(list, `${list} needs at least one entry`)
    const seen = new Map()
    arr.forEach((o, i) => {
      const base = `${list}.${i}`
      if (!isObj(o)) return err(base, 'must be an object')
      if (!isStr(o.key) || !KEBAB_RE.test(o.key)) err(`${base}.key`, 'key must be kebab-case: a-z, 0-9, single dashes')
      else if (seen.has(o.key)) err(`${base}.key`, `key "${o.key}" is already used by #${seen.get(o.key) + 1}`)
      else seen.set(o.key, i)
      str(o, base, 'label', { required: true })
      extra?.(o, base)
    })
  }
  keyed('disciplines', (o, base) => {
    str(o, base, 'longLabel')
    if (!parseColor(o.glow)) err(`${base}.glow`, 'glow must be a colour like rgba(255,180,83,.12)')
    if (typeof o.showOnHome !== 'boolean') err(`${base}.showOnHome`, 'showOnHome must be true/false')
  })
  keyed('consoles')
  keyed('coverKinds', (o, base) => {
    if (!FITS.includes(o.fit)) err(`${base}.fit`, `fit must be ${FITS.join(' | ')}`)
    for (const k of ['cardAspect', 'heroAspect']) if (!isStr(o[k]) || !ASPECT_RE.test(o[k])) err(`${base}.${k}`, `${k} must look like 16/9`)
    int(o, base, 'heroMaxVh', { min: 1, max: 100 })
    int(o, base, 'showcaseBonus')
    if (typeof o.heroEligible !== 'boolean') err(`${base}.heroEligible`, 'heroEligible must be true/false')
  })

  const d = s.defaults
  if (isObj(d)) {
    for (const [field, list] of Object.entries(KINDS)) {
      const keys = Array.isArray(s[list]) ? s[list].map((x) => x?.key) : []
      if (!keys.includes(d[field])) err(`defaults.${field}`, `default ${field} "${d[field]}" is not one of ${list}`)
    }
    str(d, 'defaults', 'newProjectRole', { required: true })
  } else if (d !== undefined) err('defaults', 'defaults must be an object')

  const r = s.roles
  if (isObj(r)) {
    strList(r, 'roles', 'vocabulary', { unique: true })
    if (Array.isArray(r.vocabulary)) r.vocabulary.forEach((t, i) => { if (isStr(t) && / \/ /.test(t)) err(`roles.vocabulary.${i}`, 'a term cannot contain " / " (that separates roles)') })
    strList(r, 'roles', 'creditRoles', { unique: true })
    if (Array.isArray(r.tiers)) {
      r.tiers.forEach((t, i) => {
        if (!isObj(t)) return err(`roles.tiers.${i}`, 'must be { match, score }')
        if (!isStr(t.match) || !t.match.trim()) err(`roles.tiers.${i}.match`, 'regex is required')
        else if (!compileTier(t.match)) {
          let why = ''
          try { new RegExp(t.match) } catch (e) { why = e.message }
          err(`roles.tiers.${i}.match`, `regex does not compile${why ? `: ${why}` : ''}`)
        }
        int(t, `roles.tiers.${i}`, 'score')
      })
    } else err('roles.tiers', 'tiers must be a list')
    int(r, 'roles', 'fallbackScore')
  } else if (r !== undefined) err('roles', 'roles must be an object')

  const k = s.ranking
  if (isObj(k)) {
    int(k, 'ranking', 'resumeMinScore')
    int(k, 'ranking', 'resumeCount', { min: 0 })
    int(k, 'ranking', 'homeCount', { min: 1 })
    if (Array.isArray(k.workPageSizes) && k.workPageSizes.length) {
      const seen = new Set()
      k.workPageSizes.forEach((n, i) => {
        if (!isInt(n) || n < 0) err(`ranking.workPageSizes`, `page size #${i + 1} must be a whole number ≥ 0 (0 = all)`)
        else if (seen.has(n)) err('ranking.workPageSizes', `page size ${n} is listed twice`)
        seen.add(n)
      })
      if (!k.workPageSizes.includes(k.workDefaultPageSize)) err('ranking.workDefaultPageSize', 'default page size must be one of the page sizes')
    } else err('ranking.workPageSizes', 'workPageSizes must be a non-empty list of numbers')
    if (Array.isArray(k.recency)) {
      k.recency.forEach((x, i) => {
        if (!isObj(x)) return err(`ranking.recency.${i}`, 'must be { maxAgeYears, bonus }')
        int(x, `ranking.recency.${i}`, 'maxAgeYears', { min: 0 })
        int(x, `ranking.recency.${i}`, 'bonus')
      })
    } else err('ranking.recency', 'recency must be a list')
    int(k, 'ranking', 'galleryCap', { min: 0 })
    if (typeof k.galleryDivisor !== 'number' || !(k.galleryDivisor > 0)) err('ranking.galleryDivisor', 'galleryDivisor must be a number > 0')
    int(k, 'ranking', 'featuredBoost')
  } else if (k !== undefined) err('ranking', 'ranking must be an object')

  const rs = s.resume
  if (isObj(rs)) {
    str(rs, 'resume', 'summary')
    str(rs, 'resume', 'education')
    if (Array.isArray(rs.experience)) rs.experience.forEach((x, i) => {
      if (!isObj(x)) return err(`resume.experience.${i}`, 'must be an object')
      for (const f of ['title', 'org', 'place', 'when', 'note']) str(x, `resume.experience.${i}`, f, { required: f === 'title' })
    })
    else err('resume.experience', 'experience must be a list')
    if (Array.isArray(rs.skills)) rs.skills.forEach((x, i) => {
      if (!isObj(x)) return err(`resume.skills.${i}`, 'must be { label, text }')
      str(x, `resume.skills.${i}`, 'label', { required: true }); str(x, `resume.skills.${i}`, 'text')
    })
    else err('resume.skills', 'skills must be a list')
    strList(rs, 'resume', 'credentials')
  } else if (rs !== undefined) err('resume', 'resume must be an object')

  const a = s.about
  if (isObj(a)) {
    strList(a, 'about', 'bio')
    strList(a, 'about', 'capabilities')
    strList(a, 'about', 'credentials')
  } else if (a !== undefined) err('about', 'about must be an object')

  const t = s.theme
  if (isObj(t)) {
    for (const f of ['accentDark', 'ctaInk']) if (!isStr(t[f]) || !HEX_RE.test(t[f])) err(`theme.${f}`, `${f} must be #rrggbb`)
    if (t.accentLight !== null && (!isStr(t.accentLight) || !HEX_RE.test(t.accentLight))) err('theme.accentLight', 'accentLight must be #rrggbb or null (same as dark)')
  } else if (t !== undefined) err('theme', 'theme must be an object')
  return errs
}

// ---- usage -------------------------------------------------------------------

export const rolesOf = (role) => String(role || '').split(' / ').map((x) => x.trim()).filter(Boolean)

// projects: [{ folder, data }]. A project that omits console/coverKind relies
// on the default — listed under `implicit` rather than against a key, because
// changing the default (not deleting a key) is what moves those.
export function usageOf(projects, s) {
  const out = { discipline: {}, console: {}, coverKind: {}, implicit: { console: [], coverKind: [] }, roles: {}, creditRoles: {} }
  for (const k of Object.keys(KINDS)) for (const o of s?.[KINDS[k]] || []) out[k][o.key] = []
  for (const t of s?.roles?.vocabulary || []) out.roles[t] = 0
  for (const t of s?.roles?.creditRoles || []) out.creditRoles[t] = 0
  for (const { folder, data } of projects) {
    if (!data) continue
    for (const k of Object.keys(KINDS)) {
      const v = data[k]
      if (v === undefined || v === null || v === '') { if (out.implicit[k]) out.implicit[k].push(folder); continue }
      ;(out[k][v] ||= []).push(folder)
    }
    for (const t of new Set(rolesOf(data.role))) out.roles[t] = (out.roles[t] || 0) + 1
    for (const c of data.credits || []) if (c?.role) out.creditRoles[c.role] = (out.creditRoles[c.role] || 0) + 1
  }
  return out
}

// Keys a project uses explicitly that `next` no longer defines.
export function deletedInUse(next, projects) {
  const use = usageOf(projects, null)
  const errs = []
  for (const [field, list] of Object.entries(KINDS)) {
    const keys = new Set((next?.[list] || []).map((o) => o?.key))
    for (const [key, folders] of Object.entries(use[field])) {
      if (folders.length && !keys.has(key)) {
        errs.push({ path: list, msg: `${field} "${key}" is used by ${folders.length} project${folders.length === 1 ? '' : 's'}: ${folders.join(', ')} — reassign them first`, key, field, projects: folders })
      }
    }
  }
  return errs
}

// ---- ranking -----------------------------------------------------------------

export function tierIndex(role, s) {
  const r = String(role || '').toLowerCase()
  const tiers = s.roles.tiers || []
  for (let i = 0; i < tiers.length; i++) {
    const re = compileTier(tiers[i].match)
    if (re && re.test(r)) return i
  }
  return -1
}
export function roleScore(role, s) {
  const i = tierIndex(role, s)
  return i >= 0 ? s.roles.tiers[i].score : s.roles.fallbackScore
}
export function recencyBonus(age, s) {
  for (const r of s.ranking.recency || []) if (age <= r.maxAgeYears) return r.bonus
  return 0
}

// [{ folder, data }] → entries with schema defaults applied and publishedAt as ms.
export function entriesOf(projects, s) {
  return (projects || []).map((p) => {
    const d = p.data || {}
    return {
      folder: p.folder,
      data: {
        ...d,
        coverKind: d.coverKind ?? s.defaults.coverKind,
        console: d.console ?? s.defaults.console,
        gallery: Array.isArray(d.gallery) ? d.gallery : [],
        featured: !!d.featured,
        draft: !!d.draft,
        pub: Date.parse(d.publishedAt ?? '') || 0,
      },
    }
  }).filter((e) => typeof e.data.role === 'string' && Number.isInteger(e.data.year))
}

export function showcaseScore(data, newestYear, s) {
  const k = s.ranking
  const kind = s.coverKinds.find((c) => c.key === data.coverKind)
  return roleScore(data.role, s) +
    Math.min(data.gallery.length, k.galleryCap) / k.galleryDivisor +
    (kind?.showcaseBonus ?? 0) +
    recencyBonus(newestYear - data.year, s) +
    (data.featured ? k.featuredBoost : 0)
}

const rounded = (n) => Math.round(n * 100) / 100

// Live (non-draft) entries → the homepage and résumé lists the site would build.
export function rank(entries, s) {
  const live = entries.filter((e) => !e.data.draft)
  const newestYear = live.length ? Math.max(...live.map((e) => e.data.year)) : 0
  const scored = live.map((e) => ({ e, s: showcaseScore(e.data, newestYear, s) }))
  const home = scored.filter((x) => x.e.data.cover)
    .sort((a, b) => b.s - a.s || b.e.data.pub - a.e.data.pub)
    .slice(0, s.ranking.homeCount)
  const heroKinds = new Set(s.coverKinds.filter((c) => c.heroEligible).map((c) => c.key))
  const hero = (home.find((x) => heroKinds.has(x.e.data.coverKind)) ?? home[0])?.e.folder ?? null
  const resumeAll = live
    .filter((e) => roleScore(e.data.role, s) >= s.ranking.resumeMinScore && (e.data.venue || e.data.client))
    .sort((a, b) => b.data.pub - a.data.pub)
  return {
    newestYear,
    scores: Object.fromEntries(scored.map((x) => [x.e.folder, rounded(x.s)])),
    home: home.map((x) => ({ folder: x.e.folder, title: x.e.data.title, year: x.e.data.year, score: rounded(x.s), coverKind: x.e.data.coverKind, hero: x.e.folder === hero })),
    hero,
    resumeAll: resumeAll.map((e) => e.folder),
    resume: resumeAll.slice(0, s.ranking.resumeCount).map((e) => ({
      folder: e.folder, title: e.data.title, year: e.data.year, venue: e.data.venue || e.data.client, role: e.data.role, roleScore: roleScore(e.data.role, s),
    })),
  }
}

// Top-level sections (and the résumé-relevant paths) that differ.
export function changedSections(a, b) {
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])]
  return keys.filter((k) => !deepEqual(a?.[k], b?.[k]))
}
export function resumeChanged(a, b) {
  return RESUME_PATHS.some((p) => !deepEqual(getPath(a, p), getPath(b, p)))
}
