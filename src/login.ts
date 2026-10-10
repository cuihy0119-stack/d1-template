export function loginPage(error = "") {
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>错题练习站</title>
<link rel="stylesheet" href="/fonts/fonts.css">
<link rel="stylesheet" href="/style.css">
</head><body>
<main class="login">
<h1>错题练习站</h1>
<p class="sub">不积跬步，无以至千里</p>
<form method="post" action="/login">
<input type="password" name="passcode" placeholder="口令" autofocus required>
<button class="btn primary" type="submit">进入</button>
${error ? `<p class="err">${error}</p>` : ""}
</form></main></body></html>`;
}
