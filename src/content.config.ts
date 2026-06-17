import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const projects = defineCollection({
  loader: glob({ pattern: '**/index.{md,mdx}', base: './src/content/projects' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      discipline: z.enum(['concert', 'theatre', 'corporate-event', 'circus']),
      year: z.number().int().min(1990).max(2100),
      role: z.string(),
      venue: z.string().optional(),
      client: z.string().optional(),
      credits: z
        .array(
          z.object({
            role: z.string(),
            name: z.string(),
          }),
        )
        .default([]),
      synopsis: z.string(),
      cover: image().optional(),
      coverKind: z.enum(['photo', 'plot']).default('photo'),
      gallery: z.array(image()).default([]),
      documents: z
        .array(
          z.object({
            label: z.string(),
            file: z.string(),
          }),
        )
        .default([]),
      consoleFilesAvailable: z.boolean().default(false),
      featured: z.boolean().default(false),
      publishedAt: z.date(),
      draft: z.boolean().default(false),
    }),
});

export const collections = { projects };
