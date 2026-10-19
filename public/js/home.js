// Home page behaviour: header buttons, mobile menu and the hero slider.

(() => {
  // Swap the header buttons when the visitor is already signed in.
  CTB.api('/api/me')
    .then(() => {
      for (const el of document.querySelectorAll('[data-guest]')) el.hidden = true;
      for (const el of document.querySelectorAll('[data-member]')) el.hidden = false;
    })
    .catch(() => {});

  // ------------------------------------------------------------ header + figures

  // The menu bar tightens once the page has been scrolled.
  const header = document.querySelector('.main-nav');
  const onScroll = () => header.classList.toggle('is-scrolled', scrollY > 24);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // The figures count up the first time the band scrolls into view.
  const figures = document.querySelector('.figures');
  const countFigures = () => {
    figures.classList.add('is-counted');
    for (const el of figures.querySelectorAll('strong')) {
      const [, digits, suffix] = el.textContent.trim().match(/^(\d+)(.*)$/);
      CTB.countUp(el, Number(digits), (value) => `${value}${suffix}`, 1400);
    }
  };
  if ('IntersectionObserver' in window) {
    const watcher = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        watcher.disconnect();
        countFigures();
      },
      { threshold: 0.4 }
    );
    watcher.observe(figures);
  } else {
    countFigures();
  }

  // ------------------------------------------------------------ mobile menu

  const toggle = document.getElementById('menu-toggle');
  const menu = document.getElementById('main-menu');

  function setMenu(open) {
    menu.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  }

  toggle.addEventListener('click', () => setMenu(!menu.classList.contains('is-open')));
  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) setMenu(false);
  });

  // ------------------------------------------------------------ hero slider

  const slider = document.getElementById('slider');
  const slides = [...slider.querySelectorAll('.slide')];
  const dots = document.getElementById('slide-dots');
  const pauseButton = document.getElementById('slide-pause');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let index = 0;
  let paused = reducedMotion; // no auto-rotation for people who ask for less motion
  let hovering = false;

  dots.innerHTML = slides.map((_, i) => `<button type="button" aria-label="Go to slide ${i + 1}"></button>`).join('');
  const dotButtons = [...dots.children];

  function show(next) {
    index = (next + slides.length) % slides.length;
    slides.forEach((slide, i) => {
      slide.classList.toggle('is-active', i === index);
      slide.inert = i !== index;
    });
    dotButtons.forEach((dot, i) => dot.setAttribute('aria-current', String(i === index)));
  }

  function renderPause() {
    pauseButton.innerHTML = CTB.icon(paused ? 'play' : 'pause');
    pauseButton.setAttribute('aria-label', paused ? 'Play slides' : 'Pause slides');
    pauseButton.setAttribute('aria-pressed', String(paused));
  }

  document.getElementById('slide-prev').addEventListener('click', () => show(index - 1));
  document.getElementById('slide-next').addEventListener('click', () => show(index + 1));
  dotButtons.forEach((dot, i) => dot.addEventListener('click', () => show(i)));
  pauseButton.addEventListener('click', () => {
    paused = !paused;
    renderPause();
  });

  // Hold the current slide while someone is reading or tabbing through it.
  slider.addEventListener('mouseenter', () => (hovering = true));
  slider.addEventListener('mouseleave', () => (hovering = false));
  slider.addEventListener('focusin', () => (hovering = true));
  slider.addEventListener('focusout', () => (hovering = false));

  setInterval(() => {
    if (!paused && !hovering && !document.hidden) show(index + 1);
  }, 6500);

  show(0);
  renderPause();
})();
