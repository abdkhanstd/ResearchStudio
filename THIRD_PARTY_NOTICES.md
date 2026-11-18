# Third-party notices

Research Studio bundles the following third-party open-source components in `public/vendor/`. Each keeps its own licence;
the full licence texts are available at the linked projects.

| Component | Version | Files | Licence | Project |
|---|---|---|---|---|
| Preact (+ hooks) | 10.24.3 | `preact.module.js`, `preact-hooks.module.js` | MIT | https://github.com/preactjs/preact |
| htm | 3.1.1 | `htm.module.js` | Apache-2.0 | https://github.com/developit/htm |
| PDF.js | 4.10.38 | `pdf.min.mjs`, `pdf.worker.min.mjs` | Apache-2.0 | https://github.com/mozilla/pdf.js |
| pdf-lib | 1.17.1 | `pdf-lib.min.js` | MIT | https://github.com/Hopding/pdf-lib |
| Tesseract.js (+ core) | 5.1.1 | `tesseract/` | Apache-2.0 | https://github.com/naptha/tesseract.js |
| Tesseract English model (tessdata_best, integer) | 4.x | `tesseract/lang/eng.traineddata.gz` | Apache-2.0 | https://github.com/tesseract-ocr/tessdata_best |
| KaTeX | 0.16.11 | `katex/` | MIT (fonts: SIL OFL 1.1) | https://github.com/KaTeX/KaTeX |
| fflate | 0.8.2 | `fflate.mjs` | MIT | https://github.com/101arrowz/fflate |

The landing page and app load the typefaces Inter, Newsreader and JetBrains Mono from Google Fonts (SIL Open Font
License 1.1) when the browser can reach it; the interface falls back to system fonts otherwise.

The example paper in `examples/fedsketch/` is a synthetic test document written for this project (with deliberate
errors for the checks to find). It is covered by the project's license (LICENSE).
