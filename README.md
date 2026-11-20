# Research Studio

**Proofread your research paper together — one paragraph at a time.**

Research Studio is a first-of-its-kind workspace for the last read of a manuscript. Writing tools help you write and
review systems help editors judge; nothing was built for the moment in between, when co-authors give a finished paper
its final, careful read. Research Studio brings that read into one place: paragraph-by-paragraph proofreading with
invited readers, reading checks that keep attention honest, every number in the text checked against the paper's own
tables and figures, full history with undo, and changes written straight back into your LaTeX source.

**Hosted demo:** [studio.rykhet.com](https://studio.rykhet.com) · **Author:** Abdullah Aman Khan ·
**Licence:** [Research Studio Personal Use License](LICENSE) — personal, non-commercial use only

> **Source available, not open source.** © 2026 Abdullah Aman Khan, all rights reserved. You may read the code and run
> it for your own personal, non-commercial work. Copying, redistributing, modifying, using any part of it in another
> project, commercial use, use by organisations, offering it as a service and using it to train AI are not permitted.
> See [LICENSE](LICENSE). For any other use, ask for a written license by opening an issue.

This repository is the self-hosted edition: one Node.js process, no npm dependencies, no database, and no AI service
needed. The hosted demo runs the same code with AI proofreading, RefCheck (reference checking for PDFs, retractions
and web sources) and a round trip with the Rykhet LaTeX editor switched on.

---

## What it does

- **Upload** a PDF or a LaTeX project (folder, `.zip` or `.tex` with `.bib` and figures). It is read in the browser into
  sections, paragraphs, equations, tables, figures and references; for LaTeX, every paragraph keeps its exact position
  in the source, and the compiled PDF is paired with the source for the typeset view.
- **Invite** co-authors and colleagues by email as proofreaders or editors. An invitation is bound to one address and
  lets exactly that person create an account and join.
- **Read and suggest** in the Proof Room: one paragraph at a time, as typeset, with suggestions as live diffs, comments,
  text and area highlights, and votes. Independent review mode hides readers' suggestions from each other.
- **Reading checks**: short fill-in-the-blank questions made from the paragraph just read. Owners see pass rates and
  implausibly fast reading per reader.
- **Evidence graph**: numbers in the text ("reaches 83.5% accuracy", "improves by 2.1 points") are linked to the table
  row and column or the plotted data they come from and checked. Differences are checked as differences between rows,
  and the same quantity reported differently in two places is flagged.
- **Figures as data**: charts are read back into numbers — from the vector drawing (multi-panel figures panel by
  panel, bars, lines, scatter, box plots), from pgfplots source, by OCR of raster images, or with a click-to-digitise
  tool — and replotted so you can compare.
- **Consistency checks**: unresolved references, acronyms defined twice or used before definition, missing figures
  and tables, mixed US/UK spelling and hyphenation, duplicated sentences, placeholders.
- **Reference check** (LaTeX with `.bib`): every cited entry is looked up in Crossref, then OpenAlex and arXiv, and
  compared with its published record — fabricated entries, DOIs of another paper, title typos, authors name by name
  (missing, extra or different initials), year, venue, volume, pages and entry type. Editors fix an entry in one click
  from a side-by-side comparison; corrections go into the revised project (exports, diff, your folder), never into the
  uploaded original, and can be undone.
- **History with undo**: every change is versioned with who made it and why; milestones; three-way merges when a
  paragraph changed under a suggestion.
- **Back to your source**: accepted changes are written into your `.tex` files at their exact positions — into a
  connected local folder (Chrome/Edge) or a revised `.zip`. Edited the paper elsewhere? Import the new version and every
  edit is merged into the history, paragraph by paragraph.
- **Exports**: latexdiff-style diff project, revised LaTeX, annotated PDF with numbered side notes, review report (PDF),
  change list (Markdown or text), unified diff, all data as JSON.
- **Private by design**: invitation-only projects, manuscripts encrypted at rest (AES-256-GCM), watermarked page images
  instead of the original file for readers, an audit trail for owners.

### Self-hosted edition and hosted demo

| | Self-hosted edition (this repository) | Hosted demo (studio.rykhet.com) |
|---|---|---|
| Accounts | Built in: email + password | Rykhet ID (single sign-on) |
| Reading checks | Fill-in-the-blank, made from the text | Written by an AI |
| Evidence graph | Rule-based matching to tables and figure data | AI-assisted claim finding and judging |
| AI proofreading, rewrites, questions | — | Yes |
| Reference checking | `.bib` entries against Crossref, OpenAlex and arXiv | The same, plus RefCheck (PDFs, retractions, the web) |
| Diff PDF | Diff project (.zip) to compile with your TeX | Compiled on your computer via Rykhet LaTeX |
| Round trip with an online LaTeX editor | Import an edited version | Rykhet LaTeX, both ways |

## Quick start

Requirements: Node.js 18 or newer. Nothing to install.

```bash
git clone https://github.com/abdkhanstd/ResearchStudio
cd ResearchStudio
cp .env.example .env
```

Put two random secrets into `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

(one for `SESSION_SECRET`, another for `DATA_KEY`), then start it:

```bash
node server.js
```

Open http://localhost:4150 and create the first account: it becomes the administrator. Upload a manuscript — try
`examples/fedsketch.zip`, a small paper with deliberate mistakes for the checks to find.

For a quick look without any setup, `npm run dev` starts it with throw-away secrets and writes emails to `var/outbox`.

## Configuration

All settings live in `.env` (see [.env.example](.env.example)).

| Setting | Meaning |
|---|---|
| `BASE_URL` | Public address, e.g. `https://studio.example.org`. Used in links and emails; cookies are `Secure` on https. |
| `PORT`, `HOST` | Where the server listens (default `127.0.0.1:4150`). |
| `SESSION_SECRET` | Signs session cookies. 32+ characters. |
| `DATA_KEY` | Encrypts manuscripts at rest. Keep a copy: without it, stored projects cannot be read. |
| `OPEN_SIGNUP=1` | Anyone may create an account. Default: the first account and invited people only. |
| `STUDIO_ADMINS` | Extra administrators (comma-separated emails). |
| `SMTP_HOST`, `SMTP_PORT` | A mail relay that accepts mail from this machine without a login (e.g. Postfix on `127.0.0.1:25`). |
| `MAIL_FROM_ADDR`, `MAIL_FROM_NAME` | Sender of invitations and reminders. Sign with DKIM at the relay for good delivery. |
| `MAIL_MODE=file` | Write emails to `var/outbox` instead of sending them. |
| `MAX_PROJECTS`, `MAX_UPLOAD_MB`, `INVITES_DAILY`, `PRECHECK_DAILY` | Limits per user and per manuscript. |
| `OPENALEX_API_KEYS` | Optional, comma-separated OpenAlex keys for the reference check (used in turn; it works without). |

The reference check sends each cited entry's title, authors, year and DOI to Crossref, OpenAlex and arXiv (public
scholarly services) and caches the answers, encrypted, in `var/`. Nothing else of the manuscript leaves the server.

## Running in production

Run it behind a reverse proxy that terminates TLS, for example Caddy:

```
studio.example.org {
  reverse_proxy 127.0.0.1:4150
}
```

or nginx (raise the upload size and keep server-sent events unbuffered):

```nginx
location / {
  proxy_pass http://127.0.0.1:4150;
  proxy_set_header Host $host;
  proxy_buffering off;
  client_max_body_size 100m;
}
```

Keep it running with PM2 (`pm2 start ecosystem.config.js && pm2 save`) or a systemd service. Back up the `var/`
folder and your `.env` together.

## How it works

- **Server** (`server.js`, `lib/`): a single dependency-free Node.js process. Projects are JSON documents encrypted with
  AES-256-GCM in `var/projects/`, with an LRU cache in memory; live updates go to readers over server-sent events.
  `lib/accounts.js` keeps scrypt password hashes, `lib/assist.js` makes the reading checks and the evidence checks,
  `lib/bibcheck.js` checks `.bib` entries against their published records (in the background, results streamed to
  everyone on the project).
- **Browser** (`public/assets/`, Preact + htm, no build step): reading PDFs (PDF.js) with column and table layout
  analysis, LaTeX parsing with exact source positions, pairing LaTeX paragraphs with the compiled PDF, the figure
  digitizer (vector drawings, OCR with Tesseract.js, pgfplots), page images, the annotated PDF and the review report
  (pdf-lib), the exports and the latexdiff-style change markup (`public/assets/shared/`), and writing changes into a
  local folder (File System Access API). Heavy work stays on the reader's machine.

```
server.js             HTTP server, API, sessions, jobs
lib/                  accounts, assist (rule-based checks), bibcheck (reference check), store, mail, lint, evidence, zip
public/               landing page, sign-in, the app and its libraries (public/vendor)
examples/             a small LaTeX paper with deliberate mistakes
scripts/dev.js        development mode
```

## Feedback

Bug reports and questions are welcome as issues. Pull requests are not accepted: the code is not licensed for
modification or redistribution.

## Author

Research Studio — its concept, design, methods and code — was created by **Abdullah Aman Khan**
([@abdkhanstd](https://github.com/abdkhanstd)) and first published on 18 November 2026. To cite it, use
"Cite this repository" on GitHub ([CITATION.cff](CITATION.cff)).

## Licence

[Research Studio Personal Use License](LICENSE) © 2026 Abdullah Aman Khan. All rights reserved. Personal,
non-commercial use only; no copying, redistribution, modification, use in other projects, commercial or
organisational use. Bundled third-party components keep their own licences — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
