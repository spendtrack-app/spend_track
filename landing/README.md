# Spend Track landing page

A standalone, dependency-free HTML/CSS website. No build step, JavaScript, API,
database, remote fonts, or third-party assets are required.

## Files

- `index.html`: introduction, illustrative sample overview, verified features, and download availability.
- `styles.css`: responsive layout using the application's Honey palette.
- `assets/app-icon.svg`: copy of the existing app icon, keeping this folder independently deployable.

The existing application stays at the repository root. The landing page does not
load or change application code, configuration, storage, or backend routes.
The overview is an HTML/CSS illustration with sample data, not a live account.
The primary action opens the existing web app; desktop downloads remain explicitly
unavailable until real installers are released.

## Preview

Open `landing/index.html` directly in a browser, or from the repository root run:

```sh
python3 -m http.server 8080 --directory landing
```

Then visit `http://localhost:8080`. This serves the landing page independently of
the Express server, whose static routes remain unchanged.

## Browser checks

From the repository root, install the existing development dependencies and browser:

```sh
npm ci
npx playwright install chromium
npx playwright test --config landing/playwright.config.js
```

The checks serve the repository with Python on port 8087 and test `/landing/` at
1440, 768, 375, and 320 pixels wide. They cover asset loading, horizontal overflow,
section navigation, keyboard skip navigation, the web-app link, and unavailable
installer states. No API or database is needed. These checks use their own config
and leave the application's existing test setup unchanged.

## GitHub Pages

All local asset URLs are relative, so the page supports project-site subpaths.

- **Alongside the existing app:** with Pages publishing the repository root,
  the landing page is at `https://spendtrack-app.github.io/spend_track/landing/`.
  The app stays at `https://spendtrack-app.github.io/spend_track/`.
- **Separate website:** copy the contents of `landing/` into a dedicated
  repository's root. In that repository's Settings → Pages, publish from the
  desired branch and `/ (root)` folder. Alternatively, use a Pages workflow that
  uploads this folder as its static artifact.

Do not change this repository's Pages source to publish only `landing/` if the
existing app must remain available at its current Pages URL. No deployment or
hosting settings are changed by this addition.

## Publishing installers later

There are currently no application installers in this repository. The download
button is disabled, and every platform is explicitly marked “Not released.”
No source archive or unrelated file is presented as an installer.

When a platform has a tested release:

1. Upload the real installer to a stable location, such as a GitHub Release asset.
2. Replace that platform's status in `index.html` with a descriptive anchor
   (for example, “Download for Windows”) pointing to the actual asset.
3. Include the version, architecture, file size, and installation instructions.
4. Replace the main disabled button with a link to an available installer or to
   the platform list, and update the availability text in the hero and download
   section. Keep unreleased platforms clearly labeled.

Add further platforms by copying a `.platform` block. Keep feature descriptions
aligned with the main application. If its branding changes, update the copied icon
and the Honey color variables here.
