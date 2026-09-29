/** Branded HTML for the DevSpec open-bridge handoff tab. Self-contained CSS. */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const BRAND = {
  bg: '#faf8f5',
  card: '#ffffff',
  text: '#1a2332',
  muted: '#5c6b7f',
  primary: '#3d5a80',
  teal: '#0d9488',
  border: '#e4e9f0',
  radius: '14px',
}

function layout({ title, body, footer }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · DevSpec</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif;
      background: radial-gradient(ellipse 120% 80% at 50% -20%, #e8f0fa 0%, ${BRAND.bg} 55%);
      color: ${BRAND.text};
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: 100%;
      max-width: 440px;
      background: ${BRAND.card};
      border: 1px solid ${BRAND.border};
      border-radius: ${BRAND.radius};
      box-shadow: 0 4px 24px rgba(26, 35, 50, 0.06), 0 1px 3px rgba(26, 35, 50, 0.04);
      padding: 32px 28px 24px;
      text-align: center;
    }
    .logo {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: ${BRAND.primary};
      margin-bottom: 20px;
    }
    .icon {
      width: 52px;
      height: 52px;
      margin: 0 auto 20px;
      border-radius: 50%;
      background: linear-gradient(135deg, #ccfbf1 0%, #e0f2fe 100%);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .icon svg { width: 26px; height: 26px; color: ${BRAND.teal}; }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      line-height: 1.35;
      margin-bottom: 8px;
    }
    .repo {
      display: inline-block;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: ${BRAND.primary};
      background: #f0f4f8;
      padding: 4px 10px;
      border-radius: 6px;
      margin-bottom: 16px;
    }
    .item-title {
      font-size: 15px;
      font-weight: 500;
      color: ${BRAND.text};
      margin-bottom: 12px;
      line-height: 1.45;
    }
    p {
      font-size: 14px;
      line-height: 1.55;
      color: ${BRAND.muted};
    }
    .hint {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid ${BRAND.border};
      font-size: 12px;
      color: ${BRAND.muted};
    }
    a { color: ${BRAND.teal}; text-decoration: none; font-weight: 500; }
    a:hover { text-decoration: underline; }
    ol {
      text-align: left;
      margin: 16px 0 0;
      padding-left: 20px;
      font-size: 13px;
      line-height: 1.6;
      color: ${BRAND.muted};
    }
    ol li { margin-bottom: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">DevSpec</div>
    ${body}
    <p class="hint">${footer}</p>
  </div>
</body>
</html>`
}

const SUCCESS_ICON = `<div class="icon" aria-hidden="true">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
</div>`

export function renderOpenSuccess({ slug, itemTitle, hasPrompt }) {
  const safeSlug = escapeHtml(slug)
  const safeTitle = itemTitle ? escapeHtml(itemTitle) : ''
  const title = 'Opening in Cursor'
  const body = `
    ${SUCCESS_ICON}
    <h1>${title}</h1>
    <div class="repo">${safeSlug}</div>
    ${safeTitle ? `<p class="item-title">${safeTitle}</p>` : ''}
    <p>Cursor is opening your project folder${
      hasPrompt ? ' and pre-filling Agent chat with your action item.' : '.'
    }</p>
    ${hasPrompt ? '<p style="margin-top:10px">Review the prompt in Cursor and press <strong>Enter</strong> to send.</p>' : ''}
  `
  return layout({
    title,
    body,
    footer: 'You can close this tab · <a href="https://devspec.ai" target="_blank" rel="noopener">devspec.ai</a>',
  })
}

export function renderMissingMapping(slug) {
  const safeSlug = escapeHtml(slug)
  const body = `
    <h1>Map this repository</h1>
    <div class="repo">${safeSlug}</div>
    <p>We could not find a local folder for this repo yet.</p>
    <ol>
      <li>Open Cursor</li>
      <li>Command Palette → <strong>DevSpec: Manage repo folder mappings</strong></li>
      <li>Or open the repo once so DevSpec Autopilot can learn it</li>
      <li>Click the rocket button again</li>
    </ol>
  `
  return layout({
    title: 'Map repository',
    body,
    footer: '<a href="https://devspec.ai" target="_blank" rel="noopener">devspec.ai</a>',
  })
}
