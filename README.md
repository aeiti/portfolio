# Portfolio — Adam Manning, Lighting Design

A static portfolio site built with [Astro](https://astro.build), deployed to
GitHub Pages on push to `main`.

Live: https://aeiti.github.io/portfolio/

## Develop

```sh
npm install
npm run dev      # http://localhost:4321/portfolio/
npm run build    # writes ./dist
npm run preview  # serves the built site at /portfolio/
```

## Add a project

Each project is a folder under `src/content/projects/` named
`YYYY-slug/` with an `index.mdx` and co-located images.

```
src/content/projects/2026-some-show/
  index.mdx
  images/
    cover.jpg
    01.jpg
    02.jpg
```

Downloadable PDFs go under `public/pdfs/<slug>/`. The PDF path in
`index.mdx`'s `documents` array is the URL path the deployed site will
serve them at (the GH Pages `/portfolio` base path is prepended at render
time).

### Project frontmatter

```yaml
title: Show Title
discipline: theatre        # concert | theatre | corporate-event
year: 2026
role: Lighting Designer
venue: Optional Venue Name
client: Optional Client
synopsis: One- to three-sentence summary.
cover: ./images/cover.jpg  # optional — coverless projects get a typeset title-card fallback
coverKind: photo           # photo | plot   (controls cover image layout; ignored when cover is omitted)
gallery:
  - ./images/01.jpg
documents:
  - label: Light plot
    file: /pdfs/2026-some-show/plot.pdf
credits:
  - { role: Director, name: Jane Doe }
consoleFilesAvailable: true
featured: true             # appears on the homepage
publishedAt: 2026-04-15    # controls sort order on /work
draft: false
```

## Source files vs. published assets

The working archive on Adam's machine (e.g. `~/Desktop/Portfolio/`) holds
raw photos, Vectorworks `.vwx` files, ETC console `.esf3d` files, and
multi-page PDFs. **Don't mirror that folder into this repo.** The repo only
holds curated, web-sized assets:

- Photos resized to ≤2400px wide JPG (`sips -Z 2400 -s format jpeg ...`)
- Single downloadable PDFs (the relevant ones, not every drafting export)
- Plot covers — page 1 of the plot PDF rasterized to JPG via
  `qlmanage -t -s 2400 -o ./out input.pdf` then `sips` to JPG

ETC `.esf3d` show files stay out of the repo entirely; the
`consoleFilesAvailable: true` flag surfaces an "available on request"
line on the project page.

## Hosting

The site is hosted on GitHub Pages. The Astro config's `site` and `base`
are env-driven (`SITE_URL`, `SITE_BASE`) so swapping in a custom domain
later is a one-line change in the deploy workflow.
