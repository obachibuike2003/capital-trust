// Login and registration share one form handler; the form's data-endpoint
// decides which API call is made.

(() => {
  const form = document.getElementById('auth-form');
  const submit = form.querySelector('[type="submit"]');
  const isRegister = form.dataset.endpoint === '/api/register';

  function validate(values) {
    if (isRegister && values.fullName.trim().length < 2) return ['Enter your full name.', 'fullName'];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) return ['Enter a valid email address.', 'email'];
    if (!values.password) return ['Enter your password.', 'password'];
    if (isRegister && values.password.length < 8) return ['Password must be at least 8 characters.', 'password'];
    if (isRegister && values.password !== values.confirm) return ['The two passwords do not match.', 'confirm'];
    return null;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    CTB.clearErrors(form);

    const values = Object.fromEntries(new FormData(form));
    const problem = validate(values);
    if (problem) return CTB.showError(form, ...problem);

    CTB.setLoading(submit, true);
    try {
      const { user } = await CTB.api(form.dataset.endpoint, { method: 'POST', body: values });
      location.href = user.role === 'admin' ? '/admin' : '/dashboard';
    } catch (error) {
      CTB.showError(form, error.message, error.field);
      CTB.setLoading(submit, false);
    }
  });
})();
