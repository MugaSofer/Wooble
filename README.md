# Wooble

*A tiny search engine for [Wildbow](https://www.parahumans.net/)'s web serials.*

Named after the fictional search engine that crops up in Wildbow's stories, Wooble is a
fan-made **finder**: search across Worm, Pact, Twig, Pale, Ward and more, get ranked
results with a snippet of context, and click straight through to the real chapter on
Wildbow's own sites.

> [!IMPORTANT]
> **Wooble does not host or re-publish the stories.** It's a search index that shows a
> short snippet for context and links *out* to the original chapters — the same way a
> web search engine does. All of Wildbow's writing remains his, and every result drives
> traffic back to where he publishes it. If Wildbow would prefer this not exist, it comes
> down — no questions asked (contact: mugasofer@gmail.com).

## How it works

Wooble is a fully **static site** (hosted on GitHub Pages) — there's no server. The work
happens in two places:

```
┌─ build-time pipeline (Node, runs locally / in CI) ─────────────┐
│  fetch.js      polite cached fetcher (1 req/s, backs off)      │
│  clean.js      WordPress HTML → clean text, nav stripped       │
│  ingest-*.js   serial APIs → data/corpus/<work>.json           │
│  build-pages   corpus → indexable HTML                         │
│  pagefind      → prebuilt, lazy-loaded search index            │
└────────────────────────────────────────────────────────────────┘
        │  static files (index + UI + /pagefind/)
        ▼
┌─ the site (runs entirely in the browser) ──────────────────────┐
│  Pagefind: ranked full-text search, highlighted snippets,      │
│  results deep-link to the canonical chapter URL                │
└────────────────────────────────────────────────────────────────┘
```

[Pagefind](https://pagefind.app/) does the in-browser search: it ranks results, builds
snippets, and lazy-loads its index so even a multi-million-word corpus stays fast (the
browser only downloads the fragments a query touches).

## Sources

| Serial            | Source                          | Via                  | Status |
| ----------------- | ------------------------------- | -------------------- | ------ |
| Worm              | `parahumans.wordpress.com`      | WordPress.com API    | ✅      |
| Pact              | `pactwebserial.wordpress.com`   | WordPress.com API    | ✅      |
| Twig              | `twigserial.wordpress.com`      | WordPress.com API    | ✅      |
| Pale              | `palewebserial.wordpress.com`   | WordPress.com API    | ✅      |
| Ward / Glow-worm  | `parahumans.net`                | (bot-blocked, TODO)  | ⏳      |
| Word of God (WoG) | Reddit / blog / forum archives  | (phase 2)            | ⏳      |

## Development

Requires Node 24+ and pnpm.

```sh
pnpm install
pnpm ingest            # crawl the serial APIs → data/corpus/ (cached, polite)
pnpm build:pages       # corpus → indexable HTML in site/
pnpm index             # run Pagefind over site/
pnpm serve             # preview locally
```

The crawl is rate-limited to one request per second and caches every response under
`data/raw/`, so re-runs are cheap and kind to the source sites. Corpus and cache files
are git-ignored — Wooble ships the *index*, not the text.

## Roadmap

- [x] Polite cached ingestion of the four WordPress-hosted serials
- [ ] Page-builder + Pagefind + search UI (the actual searching)
- [ ] Ward / Glow-worm (`parahumans.net`, currently 403s bots)
- [ ] Word of God: Reddit comments, blog replies, forum archives
- [ ] GitHub Pages deploy + CI re-index

## Credits

All stories © [Wildbow (John C. McCrae)](https://www.parahumans.net/). Wooble is an
unofficial, non-commercial fan tool with no affiliation. The code is MIT-licensed; the
fiction is not — it belongs to Wildbow.
