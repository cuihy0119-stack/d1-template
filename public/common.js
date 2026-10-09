// 公共小工具
async function api(url, opts) {
	const r = await fetch(url, opts);
	if (r.status === 401) { location.href = "/login"; throw new Error("未登录"); }
	if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
	return r.json();
}
const $ = (s) => document.querySelector(s);
function el(tag, props = {}, ...kids) {
	const e = Object.assign(document.createElement(tag), props);
	for (const k of kids) e.append(k);
	return e;
}
// 文字用 textContent 写入，再让 KaTeX 渲染 $...$ 公式（含 \ce{} 化学式）
function math(root) {
	if (window.renderMathInElement) renderMathInElement(root, {
		delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }],
		throwOnError: false,
	});
}
// 手机拍的照片压缩到最长边 1600px，省流量也方便 Claude 读取
function compress(file) {
	return new Promise((resolve) => {
		if (!file.type.startsWith("image/")) return resolve(file);
		const img = new Image();
		const url = URL.createObjectURL(file);
		img.onload = () => {
			const s = Math.min(1, 1600 / Math.max(img.width, img.height));
			const c = document.createElement("canvas");
			c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
			c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
			URL.revokeObjectURL(url);
			c.toBlob((b) => resolve(b ? new File([b], "photo.jpg", { type: "image/jpeg" }) : file), "image/jpeg", 0.85);
		};
		img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
		img.src = url;
	});
}

// 底部导航
function tabbar(active) {
	document.body.classList.add("has-tabs");
	const tabs = [["/", "首页", "🏠"], ["/bank", "题库", "📚"], ["/wrong", "错题本", "📕"]];
	const nav = el("nav", { className: "tabbar" });
	for (const [href, name, icon] of tabs) {
		nav.append(el("a", { href, className: href === active ? "on" : "" }, el("b", { textContent: icon }), name));
	}
	document.body.append(nav);
}
