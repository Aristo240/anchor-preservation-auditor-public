# Anchor-Preservation Auditor: website

A static research prototype, supported by a Cosmos Institute grant. It shows recorded AI decisions from the
project's studies and runs entirely in the browser: no backend, no analytics, no model calls, no storage.

## View it locally

```
python3 -m http.server 8000
```

then open http://127.0.0.1:8000/ in a browser. Opening index.html directly from disk also works.

## Contents

Every file is listed with its SHA-256 in `MANIFEST.sha256`; `BUILD_REPORT.json` records which source
commit it was built from and what was left out.

## Licence

The site's code is MIT-licensed and its original content CC BY 4.0; third-party texts keep their own
licences, and recorded model outputs are not licensed by the project. See LICENSE, LICENSE-CONTENT.md and
LICENSING.md in the source repository.
