import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
// Dev-only content admin at http://localhost:4321/__admin/ — `apply: 'serve'`,
// so it is absent from `astro build`. See scripts/dev-admin/plugin.mjs.
import { devAdmin } from './scripts/dev-admin/plugin.mjs';

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
  vite: {
    plugins: [devAdmin({ base: BASE })],
  },
});
