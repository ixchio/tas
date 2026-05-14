/* ============================================
   Theme
   ============================================ */
const Theme = {
  get() {
    return localStorage.getItem('tas-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  },

  apply() {
    const dark = this.get() === 'dark';
    document.body.classList.toggle('dk', dark);
    const btn = document.querySelector('.theme-btn');
    if (btn) btn.textContent = dark ? 'Light' : 'Dark';
  },

  toggle() {
    localStorage.setItem('tas-theme', this.get() === 'dark' ? 'light' : 'dark');
    this.apply();
  }
};

Theme.apply();


/* ============================================
   Copy install command
   ============================================ */
function copyInstall(el) {
  navigator.clipboard.writeText('npm i -g @nightowne/tas-cli').then(function () {
    var hint = el.querySelector('.copy-hint');
    hint.textContent = 'copied';
    setTimeout(function () { hint.textContent = 'copy'; }, 2000);
  });
}


/* ============================================
   Scroll reveal
   ============================================ */
var observer = new IntersectionObserver(function (entries) {
  entries.forEach(function (entry) {
    if (entry.isIntersecting) entry.target.classList.add('visible');
  });
}, { threshold: 0.08, rootMargin: '0px 0px -60px 0px' });

document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.reveal').forEach(function (el) {
    observer.observe(el);
  });
});
