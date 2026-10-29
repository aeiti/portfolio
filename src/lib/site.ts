// Site-wide settings. Every hard-coded value that isn't per-project content
// lives in src/data/site.json; this module validates it once at load time
// (so `astro build` / `astro dev` fail loudly on bad data) and exposes typed
// helpers. Imported by server code only — never from a client <script>, or
// the bundler would ship the whole file (contact details included) to the
// browser.

import { z } from 'astro/zod';
import raw from '../data/site.json';

const kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be kebab-case');
// Values that end up inside inline style attributes or a <style> block.
const cssValue = z.string().min(1).regex(/^[#a-zA-Z0-9(),.\s%/-]+$/, 'not a plain CSS value');
const int = z.number().int();
const nonNegInt = int.min(0);

function uniqueKeys<T extends { key: string }>(list: T[], ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  list.forEach((item, i) => {
    if (seen.has(item.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'key'], message: `duplicate key "${item.key}"` });
    }
    seen.add(item.key);
  });
}

const keyed = <S extends z.ZodRawShape>(shape: S) =>
  z
    .array(z.object({ key: kebab, ...shape }))
    .min(1)
    .superRefine((list, ctx) => uniqueKeys(list as { key: string }[], ctx));

const schema = z
  .object({
    identity: z.object({
      name: z.string().min(1),
      eyebrow: z.string(),
      heroTitle: z.string(),
      heroLede: z.string(),
      ctaPrimary: z.string(),
      ctaSecondary: z.string(),
      closingCta: z.object({ title: z.string(), text: z.string(), button: z.string() }),
      resumeTagline: z.string(),
      seoDescription: z.string(),
      pageDescriptions: z.object({
        work: z.string(),
        about: z.string(),
        contact: z.string(),
        resume: z.string(),
      }),
      ogImage: z.string().min(1).nullable(),
      gaId: z.string().regex(/^G-[A-Z0-9]+$/, 'must look like G-XXXXXXX'),
      consoleNote: z.string().includes('{console}', { message: 'must contain {console}' }),
      resumePdf: z.string().regex(/^[\w.-]+\.pdf$/, 'must be a bare .pdf filename'),
    }),
    contact: z.object({
      email: z.string().email(),
      phone: z.string().min(1),
      linkedin: z.string().url(),
      linkedinLabel: z.string(),
      github: z.string().url(),
      location: z.string(),
      siteLabel: z.string(),
    }),
    nav: z.array(z.object({ label: z.string().min(1), href: z.string().min(1) })),
    disciplines: keyed({
      label: z.string().min(1),
      longLabel: z.string().min(1),
      glow: cssValue,
      showOnHome: z.boolean(),
    }),
    consoles: keyed({ label: z.string().min(1) }),
    defaults: z.object({
      discipline: z.string(),
      console: z.string(),
      coverKind: z.string(),
      newProjectRole: z.string(),
    }),
    coverKinds: keyed({
      label: z.string().min(1),
      fit: z.enum(['cover', 'contain']),
      cardAspect: cssValue,
      heroAspect: cssValue,
      heroMaxVh: z.number().positive().max(100),
      showcaseBonus: z.number(),
      heroEligible: z.boolean(),
    }),
    roles: z.object({
      vocabulary: z.array(z.string().min(1)),
      creditRoles: z.array(z.string().min(1)),
      tiers: z.array(
        z.object({
          match: z.string().min(1).superRefine((src, ctx) => {
            try {
              new RegExp(src, 'i');
            } catch (e) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid regex: ${(e as Error).message}` });
            }
          }),
          score: int,
        }),
      ),
      fallbackScore: int,
    }),
    ranking: z.object({
      resumeMinScore: int,
      resumeCount: nonNegInt,
      homeCount: int.min(1),
      workPageSizes: z.array(nonNegInt).min(1),
      workDefaultPageSize: nonNegInt,
      recency: z.array(z.object({ maxAgeYears: nonNegInt, bonus: z.number() })),
      galleryCap: nonNegInt,
      galleryDivisor: z.number().positive(),
      featuredBoost: z.number(),
    }),
    resume: z.object({
      summary: z.string(),
      experience: z.array(
        z.object({ title: z.string(), org: z.string(), place: z.string(), when: z.string(), note: z.string() }),
      ),
      skills: z.array(z.object({ label: z.string(), text: z.string() })),
      credentials: z.array(z.string()),
      education: z.string(),
    }),
    about: z.object({
      bio: z.array(z.string()),
      capabilities: z.array(z.string()),
      credentials: z.array(z.string()),
    }),
    theme: z.object({
      accentDark: cssValue,
      accentLight: cssValue.nullable(),
      ctaInk: cssValue,
    }),
  })
  .superRefine((s, ctx) => {
    const check = (list: { key: string }[], value: string, field: string) => {
      if (!list.some((x) => x.key === value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaults', field], message: `"${value}" is not a defined key` });
      }
    };
    check(s.disciplines, s.defaults.discipline, 'discipline');
    check(s.consoles, s.defaults.console, 'console');
    check(s.coverKinds, s.defaults.coverKind, 'coverKind');
    if (!s.ranking.workPageSizes.includes(s.ranking.workDefaultPageSize)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ranking', 'workDefaultPageSize'],
        message: 'must be one of workPageSizes',
      });
    }
  });

const parsed = schema.safeParse(raw);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new Error(`Invalid src/data/site.json:\n${lines.join('\n')}`);
}

export type Site = z.infer<typeof schema>;
export const site: Site = parsed.data;

type Keys = [string, ...string[]];
export const disciplineKeys = site.disciplines.map((d) => d.key) as Keys;
export const consoleKeys = site.consoles.map((c) => c.key) as Keys;
export const coverKindKeys = site.coverKinds.map((c) => c.key) as Keys;

export const identity = site.identity;
export const contact = site.contact;

const byKey = <T extends { key: string }>(list: T[]) => new Map(list.map((x) => [x.key, x]));
const disciplines = byKey(site.disciplines);
const consoles = byKey(site.consoles);
const coverKinds = byKey(site.coverKinds);

export const disciplineLabel = (key: string) => disciplines.get(key)?.label ?? key;
export const disciplineLongLabel = (key: string) => disciplines.get(key)?.longLabel ?? key;
export const disciplineGlow = (key: string) => disciplines.get(key)?.glow ?? site.disciplines[0].glow;
export const consoleLabel = (key: string) => consoles.get(key)?.label ?? key;
export const coverKind = (key: string | undefined) =>
  coverKinds.get(key ?? site.defaults.coverKind) ?? coverKinds.get(site.defaults.coverKind)!;

const tiers = site.roles.tiers.map((t) => ({ re: new RegExp(t.match, 'i'), score: t.score }));
/** First matching tier wins; tested against the lower-cased role string. */
export function roleScore(role: string): number {
  const r = role.toLowerCase();
  return tiers.find((t) => t.re.test(r))?.score ?? site.roles.fallbackScore;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * The only markup site.json allows: `*text*` becomes <em>text</em>. Everything
 * else is escaped. For element content (set:html), not attribute values.
 */
export function md(text: string): string {
  return escapeHtml(text)
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br />');
}

const base = import.meta.env.BASE_URL.replace(/\/$/, '');
/** Prefix a site-relative href ("/work/") with the deploy base; absolute URLs pass through. */
export function navHref(href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;
  return `${base}${href.startsWith('/') ? href : `/${href}`}`;
}
