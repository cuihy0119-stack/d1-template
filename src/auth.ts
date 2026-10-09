async function sha(s: string) {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

export async function passcodeOk(input: string, real: string) {
	const [a, b] = await Promise.all([sha(input), sha(real)]);
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
	return d === 0;
}
