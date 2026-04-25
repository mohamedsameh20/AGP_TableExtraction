# Ag27 Web App

React/Vite frontend for the Ag27 table extraction project.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite, usually `http://127.0.0.1:5173/`.

On Windows PowerShell, if `npm` is blocked by execution policy, use:

```bash
npm.cmd run dev
```

## Build

```bash
npm run build
```

The production files are written to `dist/`.

## Included tools

The app header includes the original React tools plus static Stitch desktop pages copied into `public/stitch-tools/`:

- `upload-tasks.html`
- `extraction-gallery.html`
- `ocr-verification-editor.html`
- `system-dashboard.html`

These pages are served by Vite as static files and displayed inside the app shell.

## Notes

- `src/App.jsx` controls the tool navigation.
- `src/index.css` contains the shared layout and iframe styles.
- `precision_monitor` did not include an HTML file, so no static page was added for it.
