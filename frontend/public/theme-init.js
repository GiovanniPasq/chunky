// Apply the saved appearance before the application renders.
(() => {
  let preference = 'system'
  try { preference = localStorage.getItem('_theme') || 'system' } catch {}
  const theme = preference === 'light' || preference === 'dark' ? preference : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
})()
