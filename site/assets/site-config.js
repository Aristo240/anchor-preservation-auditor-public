// Release settings, set at launch (both stay null/empty until the release destination is approved):
//  * publicBase: the site's public address. While it is null, downloads (such as the method card) name the pages
//    instead of printing an address, so no temporary or local address is ever written into a file a visitor keeps.
//    On release set it to the approved address, e.g. "https://example.org/auditor/".
//  * feedbackUrl: the feedback form (for example the repository's new-issue page with the feedback template). While it
//    is empty, the Privacy & feedback page says feedback opens at launch.
window.SITE_CONFIG = { publicBase: "https://aristo240.github.io/anchor-preservation-auditor-public/",
                       feedbackUrl: "https://github.com/Aristo240/anchor-preservation-auditor-public/issues/new?template=feedback.yml" };
