# Wooble

*A tiny search engine for [Wildbow](https://www.parahumans.net/)'s web serials.*

Named after the fictional search engine that crops up in Wildbow's stories, Wooble is a
fan-made **finder**: search across Worm, Pact, Twig, Pale, Ward and more, get ranked
results with a snippet of context, and click straight through to the real chapter on
Wildbow's own sites.

> [!IMPORTANT]
> **Wooble does not host or re-publish the stories.** It's a search index that shows a
> short snippet for context and links out to the original chapters — the same way a
> web search engine does. All of Wildbow's writing remains his, and every result drives
> traffic back to where he publishes it. (If Wildbow would prefer this not exist, just
> contact me and I can take it down.)

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

| Serial            	| Source                          | Via                       | Entries	 | Status |
| --------------------- | ------------------------------- | ------------------------- | -------- | ------ |
| Worm              	| `parahumans.wordpress.com`      | WordPress.com API         | 313      | ✅      |
| Pact              	| `pactwebserial.wordpress.com`   | WordPress.com API         | 154      | ✅      |
| Twig              	| `twigserial.wordpress.com`      | WordPress.com API         | 321      | ✅      |
| Pale              	| `palewebserial.wordpress.com`   | WordPress.com API         | 336      | ✅      |
| Ward / Glow-worm  	| `parahumans.net`                | HTML scrape (TOC → pages) | 280      | ✅      |
| Claw              	| `clawwebserial.blog`            | WordPress.com API         | 40       | ✅      |
| Seek             		| `seekwebserial.wordpress.com`   | WordPress.com API         | 43       | ✅      |
| WoG — blog comments	| serial comment sections		  | WordPress.com API         | 3,388    | ✅      |
| WoG — SB WoG Thread 	| `spacebattles.com`           	  | custom parser             | 952      | ✅      |
| WoG — Reddit		 	| r/Parahumans, Weaverdice (+2)   | PullPush                  | 3,250    | ✅      |

The two comment dumps (blog and Reddit) are noisy — most of it is thanks, scheduling,
moderation and banter. Each comment is classified by an LLM (Haiku) against the question
it answers, and only the on-topic **canon** statements are served; the rest stays in the
archive. The counts above are the full scrape, not the served subset.

`parahumans.net` doesn't make its REST API/feeds/sitemaps available like Wordpress (403), so
Ward is ingested by scraping the public table-of-contents for chapter links and
pulling each chapter's `entry-content` (`pipeline/ingest-html.js`). Dates come from
the `/YYYY/MM/DD/` permalink, keeping Ward consistent with the API-sourced works.

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

- [x] Polite cached ingestion of the WordPress-hosted serials (Worm, Pact, Twig, Pale, Claw, Seek)
- [x] Page-builder + Pagefind + search UI with per-work filtering and link-out
- [x] Ward / Glow-worm via HTML scrape (`parahumans.net` blocks its API)
- [x] Date controls: sort by date + year-range filter
- [x] Live on GitHub Pages (`pnpm run deploy` force-pushes site/ to gh-pages)
- [x] Word of God — Wildbow's blog comments, with the question kept as searchable context
- [x] Word of God — the SpaceBattles WoG repository thread (Reddit / SV / SB / forum quotes)
- [x] Word of God — Reddit, full comment history via PullPush + parent-context enrichment
- [x] LLM canon-classification of the comment dumps (serve the on-topic statements, archive the banter)
- [ ] Auto re-index when new chapters drop

## Credits

All stories © [Wildbow (John C. McCrae)](https://www.parahumans.net/). Wooble is an
unofficial, non-commercial fan tool with no affiliation. The code is MIT-licensed; the
fiction is not — it belongs to Wildbow.
