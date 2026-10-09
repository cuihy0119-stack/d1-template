// 去空格 + 全角转半角
export function norm(s: string): string {
	return s
		.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
		.replace(/　/g, " ")
		.replace(/\s+/g, "");
}

const letters = (xs: string[]) => [...new Set(xs.map((x) => norm(x).toUpperCase()))].sort().join("");

/** 判选择/填空。answer 为题库里的答案数组，user 为用户作答。 */
export function judge(type: string, answer: string[], user: string | string[]): boolean {
	if (type === "single" || type === "multi") {
		const u = Array.isArray(user) ? user : [user];
		return u.length > 0 && letters(u) === letters(answer);
	}
	const u = norm(Array.isArray(user) ? user.join("") : user);
	return u !== "" && answer.some((a) => norm(a) === u);
}
