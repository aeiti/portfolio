// Dev-only content admin for src/content/projects, mounted on the Astro dev
// server.
//
// Launch:
//   npm run dev
//   open http://localhost:4321/__admin/        (also served at /portfolio/__admin/)
//
// Everything here is `apply: 'serve'`, lives outside src/, and imports `yaml`
// lazily inside configureServer — so none of it exists in `astro build`
// output, and the build never even loads the YAML library.
//
// API (all JSON unless noted; loopback callers only):
//   GET    /api/projects               every project: frontmatter, body, images, content hash
//   PUT    /api/project?folder=        save { data, body, hash } (only changed keys are rewritten)
//   POST   /api/project                create { slug, year, title, discipline } from the template
//   DELETE /api/project?folder=&hash=  delete the project folder
//   POST   /api/upload                 { folder, filename, data(base64) } → ./images/<name>
//   GET    /api/file?folder=&path=     raw image bytes (thumbnails)
//   POST   /api/score                  roleScore / résumé / homepage badges (settings.mjs ranking)
//   GET    /api/settings               site settings { data, hash, source, path }
//   PUT    /api/settings               save { data, hash } — validated; 409 if the file changed
//   GET    /api/settings/usage         projects using each discipline/console/coverKind key, role counts
//   POST   /api/settings/preview       { settings } → résumé + homepage lists those settings would build
//   GET    /settings.mjs               settings.mjs itself, so the UI validates with the same code
//   GET    /api/review                 changed files, per-file diffs, per-project change summary
//   POST   /api/ship                   branch → commit → push → gh pr create (or dryRun: list commands)
//
// Site settings live in src/data/site.json. Until that file exists (it is
// added by the site-side change), the panel falls back to
// scripts/dev-admin/fixtures/site.sample.json and logs a warning — dev and
// testing only. Settings are re-read on every request, never cached.
//
// Saves go through frontmatter.mjs: surgical per-key splices, re-parsed and
// deep-compared before the file is written; a mismatch is refused.
//
// Git safety (mirrors the repo rules): never commits on main/master, never
// force-pushes, never merges, and only commits paths this panel touched —
// if anything else in the working tree is dirty, Ship refuses and lists it.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECTS_REL = 'src/content/projects'
const SETTINGS_REL = 'src/data/site.json'
const FIXTURE_ABS = path.join(__dirname, 'fixtures', 'site.sample.json')
const FOLDER_RE = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg'])
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml',
}
const MAX_UPLOAD = 30 * 1024 * 1024

// The admin rewrites source files and runs git, so it answers only to the
// local machine even if the dev server is started with --host.
function isLoopback(req) {
  const addr = req.socket.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '', err })
    })
  })
}

// Read-only git: `git diff` exits 1 when there ARE differences, so trust
// stdout whenever there is any; reject only when git gave nothing back.
async function git(root, args) {
  const r = await run('git', args, root)
  if (r.stdout) return r.stdout
  if (r.code) throw new Error((r.stderr || r.err?.message || 'git failed').split('\n')[0])
  return ''
}

// Write git (and anything that mutates): any non-zero exit rejects.
async function gitStrict(root, args) {
  const r = await run('git', args, root)
  if (r.code) throw new Error((r.stderr || r.err?.message || 'git failed').trim().split('\n')[0])
  return (r.stdout || r.stderr || '').trim()
}

function assertNotMainBranch(branch) {
  if (branch === 'main' || branch === 'master') {
    throw new Error(`refusing to commit on ${branch} — the repo is PR-only onto main`)
  }
}

function safeJoin(dir, rel) {
  if (typeof rel !== 'string' || !rel) throw new Error('missing path')
  const abs = path.resolve(dir, rel)
  if (abs !== dir && !abs.startsWith(dir + path.sep)) throw new Error('path escapes its folder')
  return abs
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readRawBody(req, limit = MAX_UPLOAD * 1.4) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let n = 0
    req.on('data', (c) => {
      n += c.length
      if (n > limit) { reject(new Error('request body too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readBody(req) {
  const raw = (await readRawBody(req)).toString('utf8')
  try { return raw ? JSON.parse(raw) : {} } catch { throw new Error('invalid JSON body') }
}

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex')
const today = () => new Date().toISOString().slice(0, 10)

// Shell-style rendering of an argv for the dry-run list and the ship log.
function shellQuote(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}

function listImages(folderAbs) {
  const out = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (IMAGE_EXT.has(path.extname(ent.name).toLowerCase())) {
        out.push('./' + path.relative(folderAbs, abs).split(path.sep).join('/'))
      }
    }
  }
  if (fs.existsSync(folderAbs)) walk(folderAbs)
  return out.sort()
}

// `base` is Astro's site base (/portfolio). Astro hands Vite a base of '/',
// so the plugin can't read it from server.config — pass it in.
export function devAdmin({ base: siteBase = '/' } = {}) {
  return {
    name: 'portfolio-dev-admin',
    apply: 'serve',
    async configureServer(server) {
      const fm = await import('./frontmatter.mjs')
      const st = await import('./settings.mjs')
      const root = server.config.root.replace(/\/$/, '')
      const projectsDir = path.join(root, PROJECTS_REL)
      const base = siteBase.endsWith('/') ? siteBase : siteBase + '/'
      const mounts = ['/__admin', `${base.replace(/\/$/, '')}/__admin`].filter((m, i, a) => a.indexOf(m) === i)

      // ---- paths this panel has touched ---------------------------------
      // Kept in the git dir (never committed) so a dev-server restart does
      // not turn the panel's own edits into "unrelated changes".
      let touchedFile = null
      const touchedPath = async () => {
        if (touchedFile) return touchedFile
        const gd = (await gitStrict(root, ['rev-parse', '--absolute-git-dir'])).trim()
        touchedFile = path.join(gd, 'portfolio-dev-admin-touched.json')
        return touchedFile
      }
      const readTouched = async () => {
        try { return new Set(JSON.parse(fs.readFileSync(await touchedPath(), 'utf8'))) } catch { return new Set() }
      }
      const writeTouched = async (set) => {
        fs.writeFileSync(await touchedPath(), JSON.stringify([...set].sort(), null, 2))
      }
      const touchPath = async (rel) => {
        const set = await readTouched()
        set.add(rel)
        await writeTouched(set)
      }
      const touch = (folder) => touchPath(`${PROJECTS_REL}/${folder}/`)

      // ---- site settings -------------------------------------------------
      let warnedFallback = false
      const settingsFile = () => {
        const abs = path.join(root, SETTINGS_REL)
        if (fs.existsSync(abs)) { warnedFallback = false; return { abs, rel: SETTINGS_REL, source: 'site' } }
        if (!warnedFallback) {
          server.config.logger.warn(`  content admin: ${SETTINGS_REL} not found — using ${path.relative(root, FIXTURE_ABS)} (dev/testing fallback only)`, { timestamp: true })
          warnedFallback = true
        }
        return { abs: FIXTURE_ABS, rel: path.relative(root, FIXTURE_ABS).split(path.sep).join('/'), source: 'fixture' }
      }
      // Re-read on every call; `applied` only skips re-applying identical text.
      let applied = null
      const loadSettings = () => {
        const f = settingsFile()
        const raw = fs.readFileSync(f.abs, 'utf8')
        let data
        try { data = JSON.parse(raw) } catch (e) { throw new Error(`${f.rel} is not valid JSON: ${e.message}`) }
        const hash = sha(raw)
        if (applied !== hash) {
          const errs = st.validateSettings(data)
          if (errs.length) throw new Error(`${f.rel} is invalid: ${errs.slice(0, 3).map((e) => `${e.path}: ${e.msg}`).join('; ')}`)
          fm.applySettings(data)
          applied = hash
        }
        return { ...f, raw, hash, data }
      }

      const folderAbs = (folder) => {
        if (!FOLDER_RE.test(folder || '')) throw new Error(`bad project folder "${folder}"`)
        return path.join(projectsDir, folder)
      }
      const imageExistsIn = (folder) => (rel) => {
        try {
          const abs = safeJoin(folderAbs(folder), rel)
          return fs.existsSync(abs) && fs.statSync(abs).isFile()
        } catch { return false }
      }

      const loadProject = (folder) => {
        const dir = folderAbs(folder)
        const file = path.join(dir, 'index.mdx')
        const src = fs.readFileSync(file, 'utf8')
        const { data, body } = fm.readProject(src)
        return { folder, slug: folder, data, body, hash: sha(src), images: listImages(dir) }
      }
      const projectData = () => listProjects().filter((p) => !p.error).map((p) => ({ folder: p.folder, data: p.data }))
      const listProjects = () => {
        if (!fs.existsSync(projectsDir)) return []
        return fs.readdirSync(projectsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && fs.existsSync(path.join(projectsDir, d.name, 'index.mdx')))
          .map((d) => {
            try { return loadProject(d.name) } catch (e) { return { folder: d.name, slug: d.name, error: e.message } }
          })
      }

      // ---- git status ----------------------------------------------------
      const status = async () => {
        const raw = await git(root, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'])
        return raw.split('\0').filter(Boolean).map((e) => ({ status: e.slice(0, 2), path: e.slice(3) }))
      }
      const currentBranch = async () => (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

      // Split the dirty tree into panel-owned paths and everything else.
      const scope = async () => {
        const files = await status()
        const touched = await readTouched()
        const inScope = (p) => [...touched].some((t) => p.startsWith(t))
        const mine = files.filter((f) => inScope(f.path))
        const unrelated = files.filter((f) => !inScope(f.path))
        // Forget touched folders that are clean again (reverted or shipped).
        const live = new Set([...touched].filter((t) => files.some((f) => f.path.startsWith(t))))
        if (live.size !== touched.size) await writeTouched(live)
        return { files, mine, unrelated }
      }

      const fileDiff = async (f) => {
        const untracked = f.status === '??'
        const diff = untracked
          ? await git(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', f.path])
          : await git(root, ['diff', '--no-color', 'HEAD', '--', f.path])
        return diff
      }

      const headFile = async (rel) => {
        const r = await run('git', ['show', `HEAD:${rel}`], root)
        return r.code ? null : r.stdout
      }

      // Per-project summary of what changed vs HEAD, for drafting commit/PR text.
      const summarize = async (mine) => {
        const folders = [...new Set(mine.filter((f) => f.path.startsWith(PROJECTS_REL + '/'))
          .map((f) => f.path.slice(PROJECTS_REL.length + 1).split('/')[0]))].sort()
        const out = []
        for (const folder of folders) {
          const rel = `${PROJECTS_REL}/${folder}/index.mdx`
          const before = await headFile(rel)
          const abs = path.join(projectsDir, folder, 'index.mdx')
          const after = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
          const images = mine.filter((f) => f.path.startsWith(`${PROJECTS_REL}/${folder}/`) && !f.path.endsWith('/index.mdx'))
            .map((f) => ({ path: f.path.slice(PROJECTS_REL.length + folder.length + 2), status: f.status.trim() }))
          let title = folder, keys = [], bodyChanged = false, kind = 'modified'
          try {
            const b = before ? fm.readProject(before) : null
            const a = after ? fm.readProject(after) : null
            title = (a ?? b)?.data?.title ?? folder
            if (!b) kind = 'added'
            else if (!a) kind = 'deleted'
            else {
              keys = [...new Set([...Object.keys(a.data), ...Object.keys(b.data)])]
                .filter((k) => !fm.deepEqual(a.data[k], b.data[k]))
              bodyChanged = a.body !== b.body
            }
          } catch { /* unparseable — still listed */ }
          out.push({ folder, title, kind, keys, bodyChanged, images })
        }
        return out
      }

      // ---- showcase / résumé badges -------------------------------------
      // Pure-JS ranking from settings.mjs, driven by the site settings, so the
      // badges and the Settings preview use one implementation. When
      // src/lib/showcase.ts still exports roleScore(role), it is cross-checked
      // and any disagreement is reported as `drift`.
      const score = async ({ projects, folder }) => {
        const settings = loadSettings().data
        const entries = st.entriesOf(projects, settings)
        const target = entries.find((e) => e.folder === folder)
        if (!target) throw new Error('project not found in score request')
        const r = st.rank(entries, settings)
        const { resumeMinScore: min, resumeCount, homeCount } = settings.ranking
        const rs = st.roleScore(target.data.role, settings)
        const rIdx = r.resumeAll.indexOf(folder)
        const hIdx = r.home.findIndex((x) => x.folder === folder)
        const tier = st.tierIndex(target.data.role, settings)
        const why = []
        if (target.data.draft) why.push('draft')
        if (rs < min) why.push(`roleScore ${rs} < ${min}`)
        if (!target.data.venue && !target.data.client) why.push('no venue or client')
        if (rIdx >= resumeCount) why.push(`#${rIdx + 1} by date; résumé shows ${resumeCount}`)
        let drift = null
        try {
          const mod = await server.ssrLoadModule('/src/lib/showcase.ts')
          if (typeof mod.roleScore === 'function' && mod.roleScore.length <= 1) {
            const off = entries.filter((e) => mod.roleScore(e.data.role) !== st.roleScore(e.data.role, settings))
            if (off.length) drift = `src/lib/showcase.ts scores ${off.length} role(s) differently from site settings (e.g. "${off[0].data.role}")`
          }
        } catch { /* showcase.ts reads settings itself, or is unavailable — nothing to compare */ }
        return {
          roleScores: Object.fromEntries(entries.map((e) => [e.folder, st.roleScore(e.data.role, settings)])),
          roleScore: rs,
          tier: tier >= 0 ? { index: tier, match: settings.roles.tiers[tier].match } : null,
          resumeMinScore: min,
          showcaseScore: Math.round(st.showcaseScore(target.data, r.newestYear || target.data.year, settings) * 100) / 100,
          resume: { included: rIdx >= 0 && rIdx < resumeCount, rank: rIdx + 1, of: resumeCount, why },
          homepage: {
            eligible: !!target.data.cover && !target.data.draft,
            included: hIdx >= 0, rank: hIdx + 1, of: homeCount, hero: r.hero === folder,
            why: target.data.draft ? ['draft'] : !target.data.cover ? ['no cover image'] : hIdx < 0 ? [`not in top ${homeCount}`] : [],
          },
          drift,
        }
      }

      const writeSettings = (f, data) => {
        const out = JSON.stringify(data, null, 2) + '\n'
        const before = fs.existsSync(f.abs) ? fs.readFileSync(f.abs, 'utf8') : null
        fs.mkdirSync(path.dirname(f.abs), { recursive: true })
        fs.writeFileSync(f.abs, out)
        // Re-read and deep-compare what landed on disk with what was intended.
        const landed = fs.readFileSync(f.abs, 'utf8')
        let back
        try { back = JSON.parse(landed) } catch { back = undefined }
        if (landed !== out || !st.deepEqual(back, data)) {
          if (before !== null) fs.writeFileSync(f.abs, before)
          throw new Error('settings write verification failed — original restored')
        }
        return out
      }

      // What the saved settings change vs HEAD, for the review and drafts.
      const summarizeSettings = async (mine) => {
        const f = settingsFile()
        if (!mine.some((x) => x.path === f.rel)) return null
        const before = await headFile(f.rel)
        let a = null, b = null
        try { a = JSON.parse(fs.readFileSync(f.abs, 'utf8')) } catch { /* deleted or broken */ }
        try { b = before === null ? null : JSON.parse(before) } catch { /* unparseable at HEAD */ }
        return {
          path: f.rel, kind: b ? 'modified' : 'added',
          sections: b ? st.changedSections(a, b) : st.TOP_KEYS,
          // No HEAD version means the file is new — the PDF may be stale too.
          resumeChanged: !b || st.resumeChanged(a, b),
        }
      }

      // ---- ship ------------------------------------------------------------
      const branchExists = async (name) => {
        const local = await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], root)
        const remote = await run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`], root)
        return local.code === 0 || remote.code === 0
      }
      const validBranchName = (name) => {
        if (!BRANCH_RE.test(name || '') || name.includes('..') || name.endsWith('/') ||
            name.endsWith('.lock') || name.includes('//') || name.includes('@{')) {
          throw new Error('branch name: letters, digits, . _ / -; no leading dash, no "..", no trailing / or .lock')
        }
        if (name === 'main' || name === 'master' || name === 'HEAD') throw new Error(`"${name}" is not allowed`)
      }

      const ship = async (opts) => {
        const { mode, branch: wanted, message, title, body, dryRun } = opts
        if (!message || !message.trim()) throw new Error('commit message is required')
        if (!title || !title.trim()) throw new Error('PR title is required')
        const cur = await currentBranch()
        if (cur === 'HEAD') throw new Error('HEAD is detached — check out a branch first')
        const onMain = cur === 'main' || cur === 'master'
        const effMode = onMain ? 'new' : mode === 'current' ? 'current' : 'new'
        const target = effMode === 'current' ? cur : wanted
        if (effMode === 'new') {
          validBranchName(target)
          if (await branchExists(target)) throw new Error(`branch "${target}" already exists — pick another name`)
        }
        assertNotMainBranch(target)

        const { mine, unrelated } = await scope()
        if (unrelated.length) {
          const err = new Error('other uncommitted changes in the working tree — commit or revert them first; Ship only commits what this panel changed')
          err.details = unrelated.map((f) => `${f.status} ${f.path}`)
          throw err
        }
        if (!mine.length) throw new Error('nothing to ship — no panel changes in the working tree')
        const paths = [...new Set(mine.map((f) => f.path))]
        const staged = (await git(root, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean)
        const strayStaged = staged.filter((p) => !paths.includes(p))
        if (strayStaged.length) {
          const err = new Error('the index has staged files the panel did not change')
          err.details = strayStaged
          throw err
        }

        const steps = []
        if (effMode === 'new') steps.push({ cmd: 'git', args: ['checkout', '-b', target] })
        steps.push({ cmd: 'git', args: ['add', '-A', '--', ...paths] })
        steps.push({ cmd: 'git', args: ['commit', '-m', message.trim()], guard: true })
        steps.push({ cmd: 'git', args: ['push', '-u', 'origin', target] })
        steps.push({ cmd: 'gh', args: ['pr', 'create', '--base', 'main', '--head', target, '--title', title.trim(), '--body', body || ''], pr: true })
        const commands = steps.map((s) => shellQuote([s.cmd, ...s.args]) + (s.pr ? '   # skipped if a PR for this branch already exists' : ''))
        if (dryRun) return { dryRun: true, branch: target, mode: effMode, commands, files: paths }

        const log = []
        let prUrl = null
        for (const s of steps) {
          if (s.guard) {
            // Re-check the real branch right before committing.
            const now = await currentBranch()
            assertNotMainBranch(now)
            if (now !== target) throw Object.assign(new Error(`expected to be on ${target}, on ${now}`), { log })
          }
          if (s.pr) {
            const existing = await run('gh', ['pr', 'view', target, '--json', 'url,state', '-q', 'select(.state=="OPEN") | .url'], root)
            if (existing.code === 0 && existing.stdout.trim()) {
              prUrl = existing.stdout.trim()
              log.push({ cmd: shellQuote([s.cmd, ...s.args]), ok: true, output: `PR already open: ${prUrl} (not creating another)` })
              continue
            }
          }
          const r = await run(s.cmd, s.args, root)
          const output = (r.stdout + r.stderr).trim()
          log.push({ cmd: shellQuote([s.cmd, ...s.args]), ok: r.code === 0, output })
          if (r.code) throw Object.assign(new Error(`${s.cmd} ${s.args[0]} failed — stopped; nothing after it ran`), { log })
          if (s.pr) prUrl = (output.match(/https:\/\/\S+\/pull\/\d+/) || [output.split('\n').pop()])[0]
        }
        return { ok: true, branch: target, log, prUrl }
      }

      // ---- router ----------------------------------------------------------
      server.middlewares.use(async (req, res, next) => {
        const [pathname, qs = ''] = (req.url || '').split('?')
        const mount = mounts.find((m) => pathname === m || pathname.startsWith(m + '/'))
        if (!mount) return next()
        if (!isLoopback(req)) {
          res.statusCode = 403
          res.setHeader('content-type', 'text/plain')
          res.end('dev admin is restricted to the local machine')
          return
        }
        const url = pathname.slice(mount.length) || '/'
        const q = new URLSearchParams(qs)
        if (url === '/' && pathname === mount) {
          // Trailing slash so relative URLs inside the page resolve under the mount.
          res.statusCode = 302
          res.setHeader('location', mount + '/' + (qs ? `?${qs}` : ''))
          res.end()
          return
        }
        try {
          if (url === '/' && req.method === 'GET') {
            res.setHeader('content-type', 'text/html; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(fs.readFileSync(path.join(__dirname, 'index.html')))
            return
          }
          if (url === '/settings.mjs' && req.method === 'GET') {
            res.setHeader('content-type', 'text/javascript; charset=utf-8')
            res.setHeader('cache-control', 'no-store')
            res.end(fs.readFileSync(path.join(__dirname, 'settings.mjs')))
            return
          }
          // Every API call works against the settings as they are on disk now.
          if (url.startsWith('/api/')) loadSettings()
          if (url === '/api/projects' && req.method === 'GET') {
            return sendJson(res, 200, {
              base, projectsDir: PROJECTS_REL, branch: await currentBranch().catch(() => null),
              enums: fm.ENUMS, defaults: fm.DEFAULTS, newProject: fm.NEW_PROJECT, keys: fm.KEYS, projects: listProjects(),
            })
          }
          if (url === '/api/settings' && req.method === 'GET') {
            const cur = loadSettings()
            return sendJson(res, 200, { data: cur.data, hash: cur.hash, source: cur.source, path: cur.rel })
          }
          if (url === '/api/settings' && req.method === 'PUT') {
            const { data, hash } = await readBody(req)
            const cur = loadSettings()
            if (!hash || hash !== cur.hash) {
              return sendJson(res, 409, { error: `${cur.rel} changed on disk since it was loaded — reload settings before saving` })
            }
            const errors = [...st.validateSettings(data), ...st.deletedInUse(data, projectData())]
            if (errors.length) {
              return sendJson(res, 422, { error: `invalid settings: ${errors.map((e) => `${e.path}: ${e.msg}`).join('; ')}`, errors })
            }
            const changed = st.changedSections(data, cur.data)
            if (changed.length) {
              writeSettings(cur, data)
              await touchPath(cur.rel)
            }
            const next = loadSettings()
            return sendJson(res, 200, {
              ok: true, changed, data: next.data, hash: next.hash, source: next.source, path: next.rel,
              enums: fm.ENUMS, defaults: fm.DEFAULTS, newProject: fm.NEW_PROJECT,
            })
          }
          if (url === '/api/settings/usage' && req.method === 'GET') {
            return sendJson(res, 200, st.usageOf(projectData(), loadSettings().data))
          }
          if (url === '/api/settings/preview' && req.method === 'POST') {
            const { settings, projects } = await readBody(req)
            const errors = st.validateSettings(settings)
            if (errors.length) return sendJson(res, 422, { error: 'invalid settings', errors })
            // Unsaved project edits may be passed in; otherwise use disk.
            const list = Array.isArray(projects) ? projects : projectData()
            const saved = loadSettings().data
            const pick = (r) => ({ resume: r.resume, home: r.home, hero: r.hero, resumeTotal: r.resumeAll.length })
            return sendJson(res, 200, {
              next: pick(st.rank(st.entriesOf(list, settings), settings)),
              current: pick(st.rank(st.entriesOf(list, saved), saved)),
            })
          }
          if (url === '/api/project' && req.method === 'PUT') {
            const folder = q.get('folder')
            const { data, body, hash } = await readBody(req)
            const file = path.join(folderAbs(folder), 'index.mdx')
            if (!fs.existsSync(file)) throw new Error(`${folder} no longer exists on disk`)
            const src = fs.readFileSync(file, 'utf8')
            if (hash && hash !== sha(src)) {
              return sendJson(res, 409, { error: `${folder}/index.mdx changed on disk since it was loaded — reload it before saving` })
            }
            const errs = fm.validate(data, imageExistsIn(folder))
            if (errs.length) return sendJson(res, 422, { error: `invalid: ${errs.join('; ')}`, errors: errs })
            if (body !== undefined && typeof body !== 'string') throw new Error('body must be a string')
            const { next: out, changed, bodyChanged } = fm.buildFile(src, data, body)
            if (out !== src) {
              fs.writeFileSync(file, out)
              // Belt and braces: what landed on disk must be what we verified.
              if (fs.readFileSync(file, 'utf8') !== out) {
                fs.writeFileSync(file, src)
                throw new Error('write verification failed — original restored')
              }
              await touch(folder)
            }
            return sendJson(res, 200, { ok: true, changed, bodyChanged, project: loadProject(folder) })
          }
          if (url === '/api/project' && req.method === 'POST') {
            const { slug, year, title, discipline = fm.NEW_PROJECT.discipline } = await readBody(req)
            if (!SLUG_RE.test(slug || '')) throw new Error('slug must be kebab-case: a-z, 0-9, single dashes')
            if (!Number.isInteger(year) || year < 1990 || year > 2100) throw new Error('year must be an integer 1990–2100')
            if (!title || !String(title).trim()) throw new Error('title is required')
            if (!fm.ENUMS.discipline.includes(discipline)) throw new Error('bad discipline')
            if (/^\d{4}-/.test(slug)) throw new Error('leave the year off the slug — the folder gets it as a prefix')
            const folder = `${year}-${slug}`
            const taken = fs.readdirSync(projectsDir).map((n) => n.replace(/^\d{4}-/, ''))
            if (fs.existsSync(path.join(projectsDir, folder)) || taken.includes(slug)) {
              throw new Error(`a project with slug "${slug}" already exists`)
            }
            const text = fm.template({ title: String(title).trim(), discipline, year, publishedAt: today() })
            fm.readProject(text) // template must parse
            fs.mkdirSync(path.join(projectsDir, folder, 'images'), { recursive: true })
            fs.writeFileSync(path.join(projectsDir, folder, 'index.mdx'), text)
            await touch(folder)
            return sendJson(res, 200, { ok: true, project: loadProject(folder) })
          }
          if (url === '/api/project' && req.method === 'DELETE') {
            const folder = q.get('folder')
            const dir = folderAbs(folder)
            const file = path.join(dir, 'index.mdx')
            if (!fs.existsSync(file)) throw new Error(`${folder} does not exist`)
            const hash = q.get('hash')
            if (hash && hash !== sha(fs.readFileSync(file, 'utf8'))) {
              return sendJson(res, 409, { error: `${folder} changed on disk since it was loaded — reload first` })
            }
            fs.rmSync(dir, { recursive: true })
            await touch(folder)
            return sendJson(res, 200, { ok: true })
          }
          if (url === '/api/upload' && req.method === 'POST') {
            const { folder, filename, data } = await readBody(req)
            const dir = path.join(folderAbs(folder), 'images')
            if (!fs.existsSync(path.join(folderAbs(folder), 'index.mdx'))) throw new Error(`${folder} does not exist`)
            const ext = path.extname(filename || '').toLowerCase()
            if (!IMAGE_EXT.has(ext)) throw new Error(`not an image type: ${ext || '(none)'}`)
            const stem = path.basename(filename, path.extname(filename)).toLowerCase()
              .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'image'
            const buf = Buffer.from(String(data || ''), 'base64')
            if (!buf.length) throw new Error('empty upload')
            if (buf.length > MAX_UPLOAD) throw new Error('image larger than 30 MB')
            fs.mkdirSync(dir, { recursive: true })
            let name = `${stem}${ext === '.jpeg' ? '.jpg' : ext}`
            for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stem}-${i}${ext === '.jpeg' ? '.jpg' : ext}`
            fs.writeFileSync(path.join(dir, name), buf)
            await touch(folder)
            return sendJson(res, 200, { ok: true, path: `./images/${name}`, renamed: name !== `${stem}${ext === '.jpeg' ? '.jpg' : ext}`, images: listImages(folderAbs(folder)) })
          }
          if (url === '/api/file' && req.method === 'GET') {
            const abs = safeJoin(folderAbs(q.get('folder')), q.get('path'))
            const ext = path.extname(abs).toLowerCase()
            if (!IMAGE_EXT.has(ext) || !fs.existsSync(abs)) { res.statusCode = 404; res.end('not found'); return }
            res.setHeader('content-type', MIME[ext])
            res.setHeader('cache-control', 'no-cache')
            fs.createReadStream(abs).pipe(res)
            return
          }
          if (url === '/api/score' && req.method === 'POST') {
            return sendJson(res, 200, await score(await readBody(req)))
          }
          if (url === '/api/review' && req.method === 'GET') {
            const { mine, unrelated } = await scope()
            const files = []
            for (const f of mine) files.push({ ...f, diff: await fileDiff(f) })
            const d = today()
            let suggested = `content-${d}`
            for (let i = 2; await branchExists(suggested); i++) suggested = `content-${d}-${i}`
            return sendJson(res, 200, {
              branch: await currentBranch(), files, unrelated,
              projects: await summarize(mine), settings: await summarizeSettings(mine), suggestedBranch: suggested,
            })
          }
          if (url === '/api/branch-check' && req.method === 'GET') {
            const name = q.get('name')
            try {
              validBranchName(name)
              if (await branchExists(name)) throw new Error(`branch "${name}" already exists`)
              return sendJson(res, 200, { ok: true })
            } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }) }
          }
          if (url === '/api/ship' && req.method === 'POST') {
            return sendJson(res, 200, await ship(await readBody(req)))
          }
        } catch (err) {
          return sendJson(res, 400, { error: err.message, details: err.details, log: err.log })
        }
        sendJson(res, 404, { error: `no admin route ${req.method} ${url}` })
      })

      // Run ahead of Astro's own middleware so the base-path guard does not
      // 404 /__admin (which sits outside /portfolio/).
      const stack = server.middlewares.stack
      const mine = stack.pop()
      stack.unshift(mine)

      server.httpServer?.once('listening', () => {
        const addr = server.httpServer.address()
        const port = typeof addr === 'object' && addr ? addr.port : 4321
        server.config.logger.info(`  content admin: http://localhost:${port}/__admin/`, { timestamp: false })
      })
    },
  }
}
