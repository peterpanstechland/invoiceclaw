# InvoiceClaw

Invoice management system for [OpenClaw](https://openclaw.ai) — CLI skill + web service + email poller.

## Features

- **OpenClaw Skill**: Vision-powered invoice processing via Telegram (photos/PDFs)
- **Web Dashboard**: Browse, filter, upload, and manage invoices
- **Reimbursement Tracking**: Mark invoices as unreimbursed/submitted/reimbursed/rejected
- **Monthly Packaging**: Auto-generate zip archives with invoices + summary CSV for your accountant
- **Email Poller**: Monitor IMAP inbox for invoice attachments
- **Chinese Invoice Types**: Rail tickets, VAT invoices, ride-hailing, taxi receipts, VAT special

## Quick Start

```bash
# Clone
git clone https://github.com/peterpanstechland/invoiceclaw.git
cd invoiceclaw

# Run with Docker
docker build -t invoiceclaw .
docker run -d -p 3000:3000 -v ./data:/data invoiceclaw

# Or run locally (Node.js 22+)
npm install
npm start
```

Open `http://localhost:3000` for the web dashboard.

## OpenClaw Integration

Copy the `skill/` directory into your OpenClaw agent's skills folder:

```bash
cp -r skill/ /path/to/openclaw/skills/invoice-manager/
```

The CLI skill (`skill/invoice-manager.mjs`) uses Node.js built-in `node:sqlite` — no npm dependencies needed inside the OpenClaw container.

## Architecture

- `server.mjs` — Express API + static file serving + email poller startup
- `public/index.html` — Vue 3 + Tailwind CSS single-page frontend
- `lib/db.mjs` — SQLite database helpers (better-sqlite3)
- `lib/email-poller.mjs` — IMAP inbox monitoring
- `lib/packager.mjs` — Monthly zip archive generation
- `skill/` — OpenClaw agent skill files (standalone, no npm deps)

## License

MIT
