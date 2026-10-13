export function loginPage(error = "") {
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Max Note 登录">
<meta name="robots" content="noindex">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/icon.png">
<meta name="apple-mobile-web-app-title" content="MAX NOTE">
<meta name="application-name" content="MAX NOTE">
<title>MAX NOTE</title>
<script>(function(n,d){var p;try{p=localStorage.perf2}catch(e){}if(p==="lite"||(!p&&((n.deviceMemory||8)<4||(n.hardwareConcurrency||8)<4))||matchMedia("(prefers-reduced-transparency: reduce)").matches)d.classList.add("lite");var h=new Date().getHours();if(h>=21||h<7)d.classList.add("night")})(navigator,document.documentElement)</script>
<link rel="stylesheet" href="/fonts/fonts.css">
<link rel="stylesheet" href="/style.css">
</head><body>
<main class="login">
<h1 class="brand"><span class="hw bt">Max Note<svg class="squig" viewBox="0 0 120 10" preserveAspectRatio="none" aria-hidden="true"><path d="M2 6C18 2 32 9 52 5s38-4 66 1"/></svg></span></h1><svg width="0" height="0" style="position:absolute" aria-hidden="true"><filter id="boil0"><feTurbulence type="fractalNoise" baseFrequency=".04" numOctaves="2" seed="2"/><feDisplacementMap in="SourceGraphic" scale="3.6"/></filter><filter id="boil1"><feTurbulence type="fractalNoise" baseFrequency=".04" numOctaves="2" seed="9"/><feDisplacementMap in="SourceGraphic" scale="3.6"/></filter><filter id="boil2"><feTurbulence type="fractalNoise" baseFrequency=".04" numOctaves="2" seed="17"/><feDisplacementMap in="SourceGraphic" scale="3.6"/></filter></svg>
<p class="sub">不积跬步，无以至千里</p>
<form method="post" action="/login">
<input type="password" name="passcode" placeholder="口令" aria-label="口令" autocomplete="current-password" autofocus required>
<button class="btn primary" type="submit">进入</button>
${error ? `<p class="err" role="alert">${error}</p>` : ""}
</form></main></body></html>`;
}
