// Shared by the browser's internal pages: honour the "reduce motion" preference.
if (window.tidePage) {
  window.tidePage.getSettings().then((s) => {
    if (s && s.reduceMotion) document.documentElement.classList.add('reduce');
  }).catch(() => {});
}
