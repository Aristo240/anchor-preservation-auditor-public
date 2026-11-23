# Publishing the site and the package

The site is static and has no build step. It can be hosted on any static host; these steps use GitHub Pages.

Repository: `Aristo240/anchor-preservation-auditor-public`. Site:
`https://aristo240.github.io/anchor-preservation-auditor-public/` (a project site, served under that folder path; every
link in the site is relative, and it was tested under this path).

1. **Licences:** `LICENSE` (MIT) and `LICENSE-CONTENT.md` (CC BY 4.0) must be present; see LICENSING.md.
2. **Launch settings** in `site/assets/site-config.js` are already set: `publicBase` (the address above) and `feedbackUrl`
   (`https://github.com/Aristo240/anchor-preservation-auditor-public/issues/new?template=feedback.yml`).
3. **Create the repository** on GitHub as `Aristo240/anchor-preservation-auditor-public`, **Public**, empty (no README,
   licence or .gitignore). Then push this repository's single commit:
   `git remote add origin https://github.com/Aristo240/anchor-preservation-auditor-public.git && git push -u origin main`
4. **Settings, General, Features:** keep **Issues** ticked (the feedback route; the template forbids posting traces or
   personal data, and blank issues are off).
5. **Settings, Pages, Build and deployment, Source: "GitHub Actions".** The included workflow (`.github/workflows/pages.yml`)
   publishes `site/` on every push to `main`. Check it under the Actions tab.
6. **Check the live site:** open the address above, click "Try the Auditor", download the package from "For developers",
   and confirm in the browser's network panel that requests go only to `aristo240.github.io`.

**The package.** The archives in `site/downloads/` are what developers download. Publishing to PyPI is optional and
separate: `python -m build package && python -m twine upload dist/*` needs a PyPI account, and the name
`priority-check` must be available.
