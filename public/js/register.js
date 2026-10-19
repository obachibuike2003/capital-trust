// Two-step registration: personal details, then account type and password.

(() => {
  const form = document.getElementById('register-form');
  const submit = form.querySelector('[type="submit"]');
  const steps = [...form.querySelectorAll('[data-step]')];
  const STEP_OF = { fullName: 1, email: 1, phone: 1, dateOfBirth: 1, country: 1 };

  form.elements.country.innerHTML = CTB.countryOptions();

  // Nobody under 18 can open an account, so cap the date picker there.
  const latest = new Date();
  latest.setFullYear(latest.getFullYear() - 18);
  form.elements.dateOfBirth.max = latest.toISOString().slice(0, 10);

  function showStep(number) {
    for (const step of steps) step.hidden = Number(step.dataset.step) !== number;
    for (const dot of document.querySelectorAll('[data-step-dot]')) {
      const index = Number(dot.dataset.stepDot);
      dot.classList.toggle('is-current', index === number);
      dot.classList.toggle('is-done', index < number);
    }
    const heading = steps[number - 1].querySelector('h1');
    heading.tabIndex = -1;
    heading.focus();
  }

  function validateDetails(values) {
    if (values.fullName.trim().length < 2) return ['Enter your full name.', 'fullName'];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) return ['Enter a valid email address.', 'email'];
    if (!/^\+?[0-9][0-9\s()-]{6,19}$/.test(values.phone.trim())) {
      return ['Enter a phone number with its country code, for example +1 555 123 4567.', 'phone'];
    }
    if (!values.dateOfBirth) return ['Enter your date of birth.', 'dateOfBirth'];
    if (values.dateOfBirth > form.elements.dateOfBirth.max) return ['You must be at least 18 to open an account.', 'dateOfBirth'];
    if (!values.country) return ['Choose your country.', 'country'];
    return null;
  }

  function validateAccount(values) {
    if (values.password.length < 8) return ['Password must be at least 8 characters.', 'password'];
    if (values.password !== values.confirm) return ['The two passwords do not match.', 'confirm'];
    if (!values.terms) return ['Tick the box to confirm your details and accept the terms.'];
    return null;
  }

  document.getElementById('next-step').addEventListener('click', () => {
    CTB.clearErrors(form);
    const problem = validateDetails(Object.fromEntries(new FormData(form)));
    if (problem) return CTB.showError(form, ...problem);
    showStep(2);
  });

  document.getElementById('prev-step').addEventListener('click', () => {
    CTB.clearErrors(form);
    showStep(1);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    CTB.clearErrors(form);

    const values = Object.fromEntries(new FormData(form));
    const detailsProblem = validateDetails(values);
    if (detailsProblem) {
      showStep(1);
      return CTB.showError(form, ...detailsProblem);
    }
    const accountProblem = validateAccount(values);
    if (accountProblem) return CTB.showError(form, ...accountProblem);

    CTB.setLoading(submit, true);
    try {
      await CTB.api('/api/register', { method: 'POST', body: { ...values, smsOptIn: Boolean(values.smsOptIn) } });
      location.href = '/dashboard';
    } catch (error) {
      if (STEP_OF[error.field]) showStep(1);
      CTB.showError(form, error.message, error.field);
      CTB.setLoading(submit, false);
    }
  });
})();
