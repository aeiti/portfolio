import type { CollectionEntry } from 'astro:content';
import { site, coverKind, roleScore } from './site';

type Project = CollectionEntry<'projects'>;

// Homepage picks itself: projects with a cover image, ranked by how much
// of the work is Adam's (role), how much there is to look at (gallery),
// and how recent it is. `featured: true` in frontmatter is a boost, not a
// hard pin — use it to nudge a project up without maintaining a list.
// All weights live in src/data/site.json (roles + ranking + coverKinds).

export { roleScore };

const { ranking } = site;

function recencyBonus(age: number): number {
  return ranking.recency.find((r) => age <= r.maxAgeYears)?.bonus ?? 0;
}

export function showcaseScore(p: Project, newestYear: number): number {
  const d = p.data;
  const age = newestYear - d.year;
  return (
    roleScore(d.role) +
    Math.min(d.gallery.length, ranking.galleryCap) / ranking.galleryDivisor +
    coverKind(d.coverKind).showcaseBonus +
    recencyBonus(age) +
    (d.featured ? ranking.featuredBoost : 0)
  );
}

export function pickShowcase(projects: Project[], count: number = ranking.homeCount): Project[] {
  const newestYear = Math.max(...projects.map((p) => p.data.year));
  return projects
    .filter((p) => p.data.cover)
    .map((p) => ({ p, s: showcaseScore(p, newestYear) }))
    .sort(
      (a, b) =>
        b.s - a.s || b.p.data.publishedAt.valueOf() - a.p.data.publishedAt.valueOf(),
    )
    .slice(0, count)
    .map(({ p }) => p);
}

/** The homepage hero: first pick whose cover kind is hero-eligible, else the first pick. */
export function pickHero(showcase: Project[]): Project | undefined {
  return showcase.find((e) => coverKind(e.data.coverKind).heroEligible) ?? showcase[0];
}
