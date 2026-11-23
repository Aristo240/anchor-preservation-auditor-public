# Anchor-Preservation Auditor (public beta)

When AI agents make decisions on your behalf, does what matters to you survive the handoffs? This repository holds a
static website that lets you explore recorded AI decisions, and `priority_check`, a Python package that tests your own
multi-agent workflow for the same problem.

**Status: public beta, 0.1.0b1.** Site: https://aristo240.github.io/anchor-preservation-auditor-public/ · Licences: [LICENSING.md](LICENSING.md).

## Three ways in

| You want to | Go to |
|---|---|
| **Try the Auditor**: predict what the AI decided in a recorded case, then see what happened (2 minutes, no account, no API key) | the site's home page, "Try the Auditor" (`site/auditor.html#start`) |
| **Audit your workflow**: run your own agents with opposite priorities, see what each agent received, change it, retest, compare | [package/README.md](package/README.md) (quickstart) and the site's "For developers" page |
| **Research and evidence**: what the studies found, how they were run, their limits, and how to check the numbers | the site's Research pages, and [research/README.md](research/README.md) |

## What is here

| Folder | Contents |
|---|---|
| `site/` | The website: static HTML, CSS, JavaScript and data. No backend, no analytics, no model calls. Open `site/index.html` through any static web server, for example `python3 -m http.server -d site 8000`. `site/MANIFEST.sha256` lists every file with its hash. |
| `package/` | `priority_check` source, tests and examples, including a working offline example workflow. Ready-built archives are in `site/downloads/`. |
| `research/` | `reproduce_study4.py`, which recomputes the Study 4 headline numbers from the released outcome rows and fails if they differ. |

## Real results and fake-model demonstrations are kept apart

- **Recorded studies** (Study 4 and the others on the Research pages): real model calls, recorded and replayed.
- **Developer examples** (the example workflow, the Inspect and Compare examples): a deterministic **fake model**. They
  show the tool working and are **not evidence about any model**. They are labelled FAKE wherever they appear.

## Main finding (Study 4)

After six AI handoffs, decisions became much less sensitive to the user's stated priority and resembled decisions made
without an explicit priority. Restating the priority at the final step restored sensitivity in this controlled
experiment. Priority pairs in which each of two opposite priorities got its own option: 24 of 24 when the final step was
told directly, 6 of 48 after six handoffs, 47 of 48 with the priority restated. One model (Gemini 2.5 Pro), 12
constructed scenarios: a controlled experiment, not a measure of how often this happens in your system.

## More

- [LIMITATIONS.md](LIMITATIONS.md): what the studies and the tool can and cannot show.
- [PRIVACY.md](PRIVACY.md): what the site and the package do with your data.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): sources of third-party content and their licences.
- [DEPLOY.md](DEPLOY.md): how the site is published.
- Feedback: [GitHub Issues](https://github.com/Aristo240/anchor-preservation-auditor-public/issues/new?template=feedback.yml). Issues are public: never include traces, prompts, keys or personal data.
