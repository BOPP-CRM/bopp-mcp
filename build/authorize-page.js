function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
export function renderAuthorizeForm(params, error) {
    const hiddenFields = Object.entries(params)
        .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`)
        .join("\n        ");
    return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>เชื่อมต่อ BOPP CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --navy: #001b44;
      --orange: #ff7e00;
      --orange-hover: #e86f00;
      --bg: #f4f6f9;
      --card: #ffffff;
      --text: #1a2b42;
      --muted: #6b7a90;
      --border: #e2e8f0;
      --error: #dc2626;
      --error-bg: #fef2f2;
      --radius: 16px;
      --input-radius: 10px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: "Sarabun", system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
      background: var(--bg);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
    }

    .page {
      width: 100%;
      max-width: 420px;
    }

    .brand {
      text-align: center;
      margin-bottom: 28px;
    }

    .brand img {
      height: 48px;
      width: auto;
      object-fit: contain;
    }

    .brand p {
      margin-top: 12px;
      font-size: 15px;
      color: var(--muted);
      font-weight: 500;
    }

    .card {
      background: var(--card);
      border-radius: var(--radius);
      padding: 32px 28px 28px;
      box-shadow:
        0 1px 2px rgba(0, 27, 68, 0.04),
        0 8px 24px rgba(0, 27, 68, 0.08);
      border: 1px solid rgba(0, 27, 68, 0.06);
    }

    .card h1 {
      font-size: 20px;
      font-weight: 700;
      color: var(--navy);
      margin-bottom: 6px;
      letter-spacing: -0.02em;
    }

    .card .hint {
      font-size: 14px;
      color: var(--muted);
      line-height: 1.55;
      margin-bottom: 24px;
    }

    .field { margin-bottom: 20px; }

    .field label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 8px;
    }

    .input-wrap {
      position: relative;
    }

    .input-wrap input {
      width: 100%;
      padding: 12px 44px 12px 14px;
      font-size: 15px;
      font-family: inherit;
      border: 1px solid var(--border);
      border-radius: var(--input-radius);
      background: #fafbfc;
      color: var(--text);
      transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
    }

    .input-wrap input::placeholder {
      color: #9ca8b8;
    }

    .input-wrap input:focus {
      outline: none;
      border-color: var(--orange);
      background: #fff;
      box-shadow: 0 0 0 3px rgba(255, 126, 0, 0.15);
    }

    .input-wrap.error input {
      border-color: var(--error);
      background: var(--error-bg);
    }

    .input-wrap.error input:focus {
      box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.12);
    }

    .toggle-visibility {
      position: absolute;
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
      border: none;
      background: transparent;
      padding: 8px 10px;
      cursor: pointer;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      border-radius: 6px;
    }

    .toggle-visibility:hover {
      color: var(--navy);
      background: rgba(0, 27, 68, 0.05);
    }

    .error-msg {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 20px;
      padding: 12px 14px;
      background: var(--error-bg);
      border: 1px solid #fecaca;
      border-radius: var(--input-radius);
      font-size: 14px;
      color: var(--error);
      line-height: 1.45;
    }

    .error-msg svg {
      flex-shrink: 0;
      margin-top: 1px;
    }

    .submit {
      width: 100%;
      padding: 14px 20px;
      font-size: 16px;
      font-weight: 600;
      font-family: inherit;
      color: #fff;
      background: linear-gradient(135deg, var(--orange) 0%, #e86f00 100%);
      border: none;
      border-radius: 999px;
      cursor: pointer;
      transition: transform 0.12s, box-shadow 0.12s, filter 0.12s;
      box-shadow: 0 4px 14px rgba(255, 126, 0, 0.35);
      margin-top: 4px;
    }

    .submit:hover {
      filter: brightness(1.03);
      box-shadow: 0 6px 20px rgba(255, 126, 0, 0.4);
    }

    .submit:active {
      transform: scale(0.98);
    }

    .footer {
      margin-top: 20px;
      text-align: center;
      font-size: 13px;
      color: var(--muted);
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="brand">
      <img src="/asset/logo.png" alt="BOPP CRM" width="160" height="48" />
      <p>เชื่อมต่อเพื่อใช้งานผ่าน Claude</p>
    </div>

    <div class="card">
      <h1>ใส่ API Key</h1>
      <p class="hint">กรอก BOPP API key ขององค์กรคุณเพื่ออนุญาตให้ Claude เข้าถึงข้อมูล CRM</p>

      ${error ? `<div class="error-msg" role="alert">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>${escapeHtml(error)}</span>
      </div>` : ""}

      <form method="POST" action="/authorize">
        ${hiddenFields}
        <div class="field">
          <label for="api_key">BOPP API Key</label>
          <div class="input-wrap${error ? " error" : ""}">
            <input
              id="api_key"
              name="api_key"
              type="password"
              required
              autocomplete="off"
              placeholder="วาง API key ของคุณที่นี่"
              autofocus
            />
            <button type="button" class="toggle-visibility" aria-label="แสดง/ซ่อน API key" onclick="toggleKey()">แสดง</button>
          </div>
        </div>
        <button type="submit" class="submit">เชื่อมต่อ</button>
      </form>

      <p class="footer">API key จะถูกใช้เฉพาะเพื่อเรียก BOPP API<br />และไม่ถูกแชร์กับบุคคลอื่น</p>
    </div>
  </div>
  <script>
    function toggleKey() {
      const input = document.getElementById("api_key");
      const btn = document.querySelector(".toggle-visibility");
      if (!input || !btn) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "ซ่อน" : "แสดง";
    }
  </script>
</body>
</html>`;
}
