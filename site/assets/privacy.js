(function () {
  var cfg = window.SITE_CONFIG || {}, a = document.getElementById("fb-link"), pending = document.getElementById("fb-pending");
  if (cfg.feedbackUrl && /^https:\/\//.test(cfg.feedbackUrl)) { a.href = cfg.feedbackUrl; a.hidden = false; pending.hidden = true; }
})();
