# Polish Movies & Series Fetcher

CLI that searches a movie or series via [TMDB](https://www.themoviedb.org/), then queries a curated list of Polish streaming sites in parallel and prints a table of matching stream links. It doesn't play anything — it just finds where a title (or a specific episode) is available.

## Requirements

- Node.js ≥ 18
- A free [TMDB API read token](https://www.themoviedb.org/settings/api)
- (Recommended) [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) for automatic Cloudflare bypass:

```sh
docker run -d --name flaresolverr -p 8191:8191 --restart unless-stopped ghcr.io/flaresolverr/flaresolverr
```

## Setup

```sh
npm install
cp .env.example .env
# then edit .env and paste your TMDB_READ_TOKEN
```

## Usage

```sh
npm run dev -- search "seksmisja"          # movie
npm run dev -- search "wiedźmin" -s 2 -e 1 # series, specific episode
npm run dev -- search "dune" --pick 1      # non-interactive TMDB pick
npm run build                              # compile to dist/ (bin: msf)
```

Interactive flow: type a query → pick the right TMDB result (Polish and English titles both work) → for series, choose a season/episode → the CLI queries all providers in parallel and prints the results:

```
┌───────────┬─────────┬──────────┬──────────────────────────────────────────┐
│ provider  │ quality │ language │ url                                      │
├───────────┼─────────┼──────────┼──────────────────────────────────────────┤
│ cda.pl    │ 1080p   │ Polski   │ https://www.cda.pl/video/...             │
│ 35mm      │ HD      │ Polski   │ https://35mm.online/vod/fabula/...       │
└───────────┴─────────┴──────────┴──────────────────────────────────────────┘
```

## Supported sites

| Site | Notes |
|---|---|
| [filman.cc](https://filman.cc/) | logged-in session kept alive automatically (see Configuration) |
| [ekino.ws](https://ekino.ws/) (formerly ekino-tv.pl) | movies + series |
| [zaluknij.cc](https://zaluknij.cc/) | Cloudflare-protected, auto-bypassed via FlareSolverr |
| [obejrzyj.to](https://obejrzyj.to/) | matched by IMDb ID |
| [cda.pl](https://www.cda.pl/) | most popular content is premium-gated; free uploads are mostly older titles |
| [cda-hd.cc](https://cda-hd.cc/) | auto-bypassed via FlareSolverr (manual cookie override supported) |
| [35mm.online](https://35mm.online/) | official WFDiF VOD — outputs page URLs (playback needs a free site login) |
| [dokumentalne.net](https://dokumentalne.net/) | documentaries (movies only) |
| [bajeczki24.pl](https://bajeczki24.pl/) | kids cartoons |
| [seriale.vip](https://seriale.vip/) | movies + series |
| [maxvod.tv](https://maxvod.tv/) | movies + series |
| [telekino.top](https://telekino.top/) | series; newest episodes login-gated |
| [virpe.cc](https://virpe.cc/) | Polish TV focus |
| [iitv.info](https://iitv.info/) | series only |
| [freedisc.pl](https://freedisc.pl/) | user uploads; geo-blocked outside Poland |
| [premiumsmart.eu](https://premiumsmart.eu/) | JSON API |
| [filmyonline.cc](https://filmyonline.cc/) | JSON API, auto-bypassed via FlareSolverr |
| [vider.info](https://vider.info/) | search currently degraded site-side; stream CDN verified |

Each provider matches by title (+ Polish *and* original titles), with a year preference; episodes are matched per season/episode, including sites that number episodes continuously across seasons.

## Configuration

All configuration lives in `.env` (see [.env.example](.env.example)):

| Variable | Purpose |
|---|---|
| `TMDB_READ_TOKEN` | TMDB JWT read token (**required**) |
| `FLARESOLVERR_URL` | FlareSolverr base URL; unset disables auto Cloudflare bypass |
| `FILMAN_CC_LOGIN` / `FILMAN_CC_PASSWORD` | filman.cc account for the auto-session (requires the two below) |
| `TWOCAPTCHA_API_KEY` | [2captcha.com](https://2captcha.com/) API key — solves filman's reCAPTCHA login (~$0.003 per login; sessions are cached in gitignored `.filman-session.json`, so this cost is rare) |
| `FILMAN_SESSION_FILE` | override the session-cache path (used by the Stremio addon's docker volume) |
| `FILMAN_CC_COOKIE` / `FILMAN_CC_UA` | manual filman.cc session fallback (UA+IP-bound, expires periodically); ignored while auto-session is configured |
| `CDA_HD_CC_COOKIE` / `CDA_HD_CC_UA` | manual cda-hd.cc override (normally auto-solved) |

### How filman.cc stays logged in

filman requires a logged-in session behind Cloudflare. With the auto-session
configured, FlareSolverr re-solves the daily Cloudflare challenge for free
(maintaining a consistent browser identity), and a full re-login — gated by a
reCAPTCHA Enterprise captcha — happens only when the session itself expires,
at which point 2Captcha solves the captcha automatically. The manual cookie
pair remains as a fallback when auto mode is not fully configured.

## Legal note

This tool only links to publicly accessible pages of third-party sites and performs no playback or download. Availability, quality and legality of content on those sites are out of this project's scope. Use at your own risk.

## License

[MIT](LICENSE)
