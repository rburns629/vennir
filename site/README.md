# vennir.io

The public website: plain static pages, served by Firebase Hosting from the
Google Cloud project `general-513718`. There is no build step. What's in
`public/` is what's served.

- `public/*.html`: one file per page. `cleanUrls` serves `product.html` at
  `/product`, and `404.html` for anything else. The header and footer are
  repeated in every page: change them in all of them.
- `public/site.js`: the only script. It plays the home page's run, copies the
  install command, and filters the Docs page's guides. It writes only its own
  constant text into the page.
- `firebase.json`: clean URLs, a short cache, and the security headers. The
  Content-Security-Policy allows scripts from the site alone, and styles and
  fonts from Google Fonts. Inline `style` attributes are allowed, because the
  pages use them throughout.

Design changes start on the mockups canvas, as the console's do.

## Changing a page

Keep the facts in step with the repo, especially the Changelog (each release)
and the Docs page (each new guide). To look at a change locally, with the
same URLs and headers as the live site:

```bash
cd site
npx firebase-tools emulators:start --only hosting --project general-513718
```

## Deploying

Merge first, then deploy from `main`. You need Firebase Hosting Admin on the
project; `firebase login`, or gcloud's application-default credentials, signs
you in.

```bash
cd site
npx firebase-tools deploy --only hosting --project general-513718
```

A deploy is live at once, at <https://vennir.io> and at
<https://general-513718.web.app>. To roll back, open Hosting in the Firebase
console and pick an earlier release.

## The domain

vennir.io is registered at Namecheap. Its DNS records there point at Firebase
Hosting. They are the records Firebase gave when the domain was added:
Hosting → Custom domains → vennir.io shows them, and whether they're still
right.
