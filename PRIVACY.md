# Privacy

## The website (`site/`)
- **Static files only.** No backend, no analytics, no cookies, no browser storage, no model calls.
- **No outbound connections.** Every page has a Content-Security-Policy that forbids connections to any address
  (`connect-src 'none'`) and loads scripts, styles and images only from the site itself.
- **What you type or open stays in your browser.** Workflow maps, priorities, run files (`summary.json`,
  `records.jsonl`) and traces opened on the Map, Inspect and trace pages are read by your browser. They are not
  uploaded, and they are gone when you reload. Files you save are written by your browser to your own device.
- **How this was checked.** Before release, every network request the browser made was recorded while going through
  the visitor journey and the developer journey (Map, Test, Inspect with run files opened from disk, Compare), served by
  a local static web server under the same folder path as the public address: 112 requests, all to the site's own
  address, all GET; opening run files made 0 requests; no cookies, no browser storage.
- **Hosting.** The service that serves the files (for example GitHub Pages) may keep standard access logs, such as IP
  address and browser type, under its own policy. The site's code adds nothing to them.
- **Feedback.** The feedback link opens the public repository's GitHub issue form, on GitHub, under GitHub's own
  privacy terms; issues are public. Please describe problems without pasting traces, prompts, keys, personal data or
  anything confidential.

## The package (`priority_check`)
- Runs on your computer and writes results only to the folder you name.
- Makes no network calls of its own. Your adapter calls whatever your workflow calls. The optional real-model providers
  call the provider you choose, with a key read from the environment variable you name; the key is never written to the
  results.
- Results contain what your agents received and returned. Treat them like your own logs before sharing them.
