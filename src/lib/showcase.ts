import type { CollectionEntry } from 'astro:content';

type Project = CollectionEntry<'projects'>;

// Homepage picks itself: projects with a cover image, ranked by how much
// of the work is Adam's (role), how much there is to look at (gallery),
// and how recent it is. `featured: true` in frontmatter is a boost, not a
// hard pin — use it to nudge a project up without maintaining a list.

function roleScore(role: string): number {
  const r = role.toLowerCase();
  if (/design|director|programmer|master electrician/.test(r)) return 3;
  if (/board/.test(r)) return 2;
  return 1;
}

export function showcaseScore(p: Project, newestYear: number): number {
  const d = p.data;
  const age = newestYear - d.year;
  return (
    roleScore(d.role) +
    Math.min(d.gallery.length, 6) / 3 +
    (d.coverKind === 'photo' ? 1 : 0) +
    (age <= 1 ? 2 : age <= 3 ? 1 : 0) +
    (d.featured ? 3 : 0)
  );
}

export function pickShowcase(projects: Project[], count: number): Project[] {
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
