// Single source for contact details. Email and phone are never written
// into the HTML as plain text — <ContactLink> stores them encoded and
// assembles the link in the browser, which keeps them out of scrapers.

export const contact = {
  email: 'adam@thomasavl.com',
  phone: '(213) 796-0937',
  linkedin: 'https://www.linkedin.com/in/adam-manning-lx',
  github: 'https://github.com/aeiti',
  location: 'Riverside, CA',
};

/** Reversed + base64, so neither the address nor the digits appear in source. */
export function encode(value: string): string {
  return Buffer.from([...value].reverse().join(''), 'utf8').toString('base64');
}
