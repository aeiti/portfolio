import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

const SITE = process.env.SITE_URL ?? 'https://aeiti.github.io';
const BASE = process.env.SITE_BASE ?? '/portfolio';

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'ignore',
  integrations: [mdx(), sitemap()],
  image: {
    responsiveStyles: true,
  },
  build: {
    format: 'directory',
  },
});
