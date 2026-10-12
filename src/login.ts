export function loginPage(error = "") {
	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="icon" href="/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/icon.png">
<meta name="apple-mobile-web-app-title" content="MAX NOTE">
<meta name="application-name" content="MAX NOTE">
<title>MAX NOTE</title>
<script>(function(n,d){var p;try{p=localStorage.perf2}catch(e){}if(p==="lite"||(!p&&((n.deviceMemory||8)<4||(n.hardwareConcurrency||8)<4))||matchMedia("(prefers-reduced-transparency: reduce)").matches)d.classList.add("lite")})(navigator,document.documentElement)</script>
<link rel="stylesheet" href="/fonts/fonts.css">
<link rel="stylesheet" href="/style.css">
</head><body>
<main class="login">
<h1 class="brand">Max Note</h1>
<p class="sub">不积跬步，无以至千里</p>
<form method="post" action="/login">
<input type="password" name="passcode" placeholder="口令" autofocus required>
<button class="btn primary" type="submit">进入</button>
${error ? `<p class="err">${error}</p>` : ""}
</form></main></body></html>`;
}
