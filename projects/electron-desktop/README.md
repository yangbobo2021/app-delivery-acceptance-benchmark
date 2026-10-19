# Local Notes Desktop
`npm ci && npm run build`; `npm start -- --user-data-dir /absolute/fresh/state`. Actual Electron application; main/preload/renderer TypeScript sources in src, mapped build output in dist. Bridge window.notes exposes list(), save({id:null or existing,title,body}), remove(id). Requirements: docs/requirements.md.
