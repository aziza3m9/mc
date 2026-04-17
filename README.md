# Medical Coding Dashboard

A single-page, browser-based dashboard for managing medical coding cases. Runs entirely client-side — all data stays in your browser's localStorage, so it's safe to use behind a VPN with no server.

## Features

- **Case list** with create/delete/switch
- **Patient information**: name, DOB, MRN, date of service, provider, facility, notes
- **Document upload**: drop images (or PDFs) under Operative Report and Diagnostics sections
- **Build Case PDF**: combines patient info, CPT codes, and all uploaded images into a single downloadable PDF
- **CPT codes**: code, description, modifiers, units
- **Hours tracked**: date, hours, task; running total displayed
- **Export / Import**: JSON backup of all data

## Usage

1. Open `index.html` in a modern browser (Chrome, Firefox, Edge, Safari).
2. Click **+ New Case** and fill in patient info.
3. Upload images under **Operative Report** and **Diagnostics**.
4. Add **CPT codes** and log **hours**.
5. Click **Build Case PDF** to generate a combined PDF.
6. Use **Export Data** regularly to back up cases.

## Dependencies

- [jsPDF](https://github.com/parallax/jsPDF) (loaded from CDN) — for image-to-PDF conversion.

If you are fully offline behind a VPN, download `jspdf.umd.min.js` and replace the CDN `<script>` tag in `index.html` with a local path.

## Data & privacy

All data lives in `localStorage` on the machine running the browser. Clearing browser data will delete cases — use **Export Data** for backups. No network calls are made aside from loading the jsPDF library.
