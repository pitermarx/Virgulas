# How to publicise and monetise

- **Priority:** P5
- **Type:** product and growth (not a code finding)
- **Spec impact:** none for the discussion; the Pricing page idea overlaps roadmap-07

## Description

Open questions from the notes, with constraints taken from what the product already promises. These are options to discuss, not recommendations I can validate from the code.

## Constraints from the product

- Privacy-first positioning: local-first, end-to-end encrypted, cookieless self-hosted analytics, no third-party trackers. Any growth or payment tool must not undermine that (and the privacy page must stay true).
- The only server cost is the Remote mode (one encrypted row per user), which is also the natural paid feature. Costs scale with the document size and poll traffic (scale-02), and open sign-up is currently an abuse risk (scale-01).
- The account page design ([roadmap-08](roadmap-08-account-page-extensions.md)) carries a payments placeholder, so monetisation was considered before.

## Monetisation options to weigh

- **Free local modes, paid Remote sync** (storage, history and multi-document, roadmap-05, as paid features). Needs a payment provider, a way to attach a plan to an account (a `plans` table keyed by `user_id`, updated by a webhook), and enforcement in RLS or an Edge Function (size limits per plan).
- **Pay what you want or sponsorship** (GitHub Sponsors, Open Collective) with no account integration: lowest effort, lowest revenue, fits an open-source project.
- **Self-hosting support** (sec-13): documented bring-your-own-backend, optional paid setup help.
- Avoid ads and any behavioural tracking.

## Publicity options to weigh

- **Pricing and landing content** as a static page using the VMD-link idea (roadmap-07), plus the existing discovery files (`llms.txt`, sitemap).
- **SEO basics:** a descriptive title and meta description (present), structured data (present), a few content pages (how encryption works, VMD format, comparison with other outliners), and the public repository's README as the main funnel.
- **Launch channels:** Show HN, relevant subreddits and the local-first and outliner communities, plus a short demo recording of keyboard-driven use.
- **Retention:** import and export in common outliner formats (OPML, Markdown) so people can try it without lock-in; the existing `.vmd` export already helps.

## Decisions needed

Who is the target user, what is the sustainable price against Supabase costs, and what is acceptable measurement given the privacy promise?

## Tests

None.

<!-- roadmap -->
## Roadmap position

- **Phase:** [10 — Growth](README.md#phase-10)
- **Size:** M
- **Do these first:** [roadmap-07](roadmap-07-load-vmd-from-query-string.md), [scale-01](scale-01-open-signup-storage-abuse.md), [web-03](web-03-core-web-vitals-measurement.md)
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** [sec-13](sec-13-hosted-auth-config-and-configurable-backends.md)
- **Related:** —
