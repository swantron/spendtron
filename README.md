# spendtron

Landing / waitlist page for **spendtron** — a read-only tool that finds which GitHub
Actions workflow is eating your CI bill, ranks workflows by real compute cost, and opens
PR-ready fixes (path filters, caching, cancel-in-progress).

Static single-page site served via GitHub Pages at [spendtron.com](https://spendtron.com).

## Status
Demand-validation phase. Building the product only after 5+ credible "would pay ~$99/mo"
signals from the waitlist form.

## Before it goes live
- [ ] Replace `REPLACE_WITH_FORM_ENDPOINT` in `index.html` with a real Formspree endpoint.
- [ ] Enable GitHub Pages (Settings → Pages → main / root).
- [ ] Point spendtron.com DNS at GitHub Pages (A records + www CNAME).
- [ ] Enforce HTTPS once DNS resolves.
