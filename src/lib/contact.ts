// Contact details live in src/data/site.json (re-exported here for existing
// imports). Email and phone are never written into the HTML as plain text —
// <ContactLink> stores them encoded and assembles the link in the browser,
// which keeps them out of scrapers.

export { contact } from './site';

/** Reversed + base64, so neither the address nor the digits appear in source. */
export function encode(value: string): string {
  return Buffer.from([...value].reverse().join(''), 'utf8').toString('base64');
}
