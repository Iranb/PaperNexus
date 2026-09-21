const form = document.getElementById('login-form');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  const error = document.getElementById('error');
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value.trim(), password: form.password.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '登录失败');
    form.password.value = '';
    window.location.replace('/');
  } catch (cause) { error.textContent = cause.message || '连接失败，请重试'; }
  finally { button.disabled = false; }
});
