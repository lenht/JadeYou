  // hero stage parallax
  const heroStage = document.getElementById('heroStage');
  const wrapA = document.getElementById('ringWrapA');
  const wrapB = document.getElementById('ringWrapB');
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (heroStage && wrapA && wrapB && !prefersReduced && window.matchMedia('(min-width: 981px)').matches) {
    heroStage.addEventListener('mousemove', (e) => {
      const rect = heroStage.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width - 0.5;
      const my = (e.clientY - rect.top) / rect.height - 0.5;
      wrapA.style.transform = `translate(${mx * -10}px, ${my * -10}px)`;
      wrapB.style.transform = `translate(${mx * 7}px, ${my * 7}px)`;
    });
    heroStage.addEventListener('mouseleave', () => {
      wrapA.style.transform = 'translate(0,0)';
      wrapB.style.transform = 'translate(0,0)';
    });
  }

  // header scroll state
  const header = document.getElementById('siteHeader');
  if (header) {
    window.addEventListener('scroll', () => {
      header.classList.toggle('scrolled', window.scrollY > 60);
    }, { passive:true });
  }

  // mobile nav toggle
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => navLinks.classList.toggle('open'));
    navLinks.querySelectorAll('a').forEach(a => a.addEventListener('click', () => navLinks.classList.remove('open')));
  }

  // scroll reveal
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

  // inquiry form -> mailto (only present on the homepage Atelier section)
  const form = document.getElementById('inquiryForm');
  if (form) {
    form.addEventListener('submit', function(e){
      e.preventDefault();
      const name = document.getElementById('fname').value;
      const email = document.getElementById('femail').value;
      const phone = document.getElementById('fphone').value;
      const interest = document.getElementById('finterest').value;
      const message = document.getElementById('fmessage').value;
      const subject = encodeURIComponent('Private Viewing Request — ' + interest);
      const body = encodeURIComponent(
        'Name: ' + name + '\n' +
        'Email: ' + email + '\n' +
        'Phone: ' + phone + '\n' +
        'Area of Interest: ' + interest + '\n\n' +
        'Message:\n' + message
      );
      window.location.href = 'mailto:hello@jadeyou.com?subject=' + subject + '&body=' + body;
    });
  }
