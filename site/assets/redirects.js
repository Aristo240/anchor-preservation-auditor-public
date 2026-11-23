// Keeps every earlier address working on the integrated site (runs before the home page draws).
//   index.html#replay/<id>, #case/<id>[/<condition>], #see, #walk, #contrast  -> experiment.html (same hash)
//   index.html#explorer, #counter, #x-…                                       -> results.html
//   Study 1 / Study 2 anchors (#S016-A14/3, #ref-…, #behavior, #study1, #explore…, #journey, #limits,
//   #step-1…6, #open, #about)                                                 -> research.html (same hash)
(function () {
  "use strict";
  function route() {
    var h = location.hash;
    if (/^#(replay|case)\//.test(h)) location.replace("experiment.html" + h);
    else if (/^#(see|walk|contrast)$/.test(h)) location.replace("experiment.html");
    else if (/^#(explorer|counter|x-[\w-]+)$/.test(h)) location.replace("results.html" + (h === "#counter" ? "#counter" : ""));
    else if (/^#(S\d{3}-A\d{2}(\/\d)?|ref-[\w-]+|behavior|study1|explore(\/.*)?|journey|limits|step-[1-6]|open|about)$/.test(h)) location.replace("research.html" + h);
  }
  route();
  window.addEventListener("hashchange", route);
})();
