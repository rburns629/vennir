# vennir.io

The public website: static pages, served by Firebase Hosting from the
Google Cloud project `general-513718`, and a page for every guide the Docs
page lists, made from the guide's Markdown in the repository at each deploy.
What's in `public/` is what's served.

- `public/*.html`: one file per page. `cleanUrls` serves `product.html` at
  `/product`, and `404.html` for anything else. The header and footer are
  repeated in every page: change them in all of them.
- `public/site.js`: the only script. It sends visitors on the project's own
  `web.app` and `firebaseapp.com` addresses to vennir.io, plays the home
  page's run, copies the install command, filters the Docs page's guides,
  runs the docs' full-text search, and has Mermaid draw a guide's diagrams.
  It writes into the page only as text and elements it makes, never markup.
- `docs-build/`: makes `public/docs/` (which git ignores): `/docs/<guide>` for
  each guide in `guides.json`, in the Docs page's order, with the guides
  beside it and its sections; `/docs/search` and its index
  (`search-index.json`, searched in the browser: nothing typed leaves it);
  Mermaid, which the CSP lets load only from the site; and the guides'
  images. Links between guides go to their pages, and other links into the
  repository to GitHub. It changes no tracked file, but fails while a link
  is broken, the Docs page's cards aren't `guides.json`'s guides in order,
  `sitemap.xml` or `llms.txt` misses a guide, or a page links to a guide's
  file on GitHub instead of its page. `make site-docs` runs it, CI does in
  the console job, and Firebase's `predeploy` before every deploy.
- For search engines and AI assistants: `robots.txt` (everyone allowed, the
  AI crawlers named), `sitemap.xml`, `llms.txt` (what Vennir is, and the
  pages, in Markdown), `og.png` (the preview a shared link shows), and in each
  page's head its own description, a canonical URL on vennir.io, Open Graph
  tags and, on some, JSON-LD (`SoftwareApplication` and `Organization` on the
  home page, `FAQPage` on the FAQ, `TechArticle` on Security and Get started).
- `public/diagrams/`: copies of `docs/architecture/`'s SVGs the pages show.
  After `generate.py` changes one, copy it here again.
- `firebase.json`: clean URLs, a short cache, and the security headers. The
  Content-Security-Policy allows scripts from the site alone, and styles and
  fonts from Google Fonts. Inline `style` attributes are allowed, because the
  pages use them throughout.

Design changes start on the mockups canvas, as the console's do.

## Changing a page

Keep the facts in step with the repo, especially the Changelog (each release)
and the Docs page (each new guide: its card, a line in
`docs-build/guides.json`, and its page in `sitemap.xml` and `llms.txt`). With each release, also change the
version in the home page's JSON-LD (`softwareVersion`) and in `llms.txt`.
A new page goes in `sitemap.xml` and `llms.txt`, with its own description
and canonical URL. The FAQ's answers are written twice, in the page and in its
`FAQPage` JSON-LD: change both, word for word. To look at a change locally, with the
same URLs and headers as the live site:

```bash
make site-docs   # the docs pages, into public/docs/
cd site
npx firebase-tools emulators:start --only hosting --project general-513718
```

## Deploying

Merge first, then deploy from `main`. The deploy makes the docs pages
first (`predeploy` in `firebase.json`), from the checkout it runs in. You need Firebase Hosting Admin on the
project; `firebase login`, or gcloud's application-default credentials, signs
you in.

```bash
cd site
npx firebase-tools deploy --only hosting --project general-513718
```

A deploy is live at once at <https://vennir.io>. The project's own address,
<https://general-513718.web.app>, sends visitors there. To roll back, open Hosting in the Firebase
console and pick an earlier release.

## The domain

vennir.io is registered at Namecheap. Its DNS records there point at Firebase
Hosting. They are the records Firebase gave when the domain was added:
Hosting → Custom domains → vennir.io shows them, and whether they're still
right.
