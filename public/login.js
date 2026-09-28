const form = document.getElementById("login-form");
const error = document.getElementById("login-error");
const submit = document.getElementById("login-submit");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  submit.disabled = true;
  try {
    const response = await fetch("/api/dashboard/login", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value.trim(),
        password: document.getElementById("password").value,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `İstek başarısız (${response.status})`);
    document.getElementById("password").value = "";
    window.location.replace("/");
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : "Giriş tamamlanamadı.";
    error.hidden = false;
    submit.disabled = false;
  }
});
