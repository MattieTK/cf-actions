/**
 * WebCrypto helpers shared by the Worker and the Durable Objects. Everything here also runs in
 * Node 20+, which is how the unit tests exercise it.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function base64UrlEncode(input: Uint8Array | string): string {
	const bytes = typeof input === "string" ? encoder.encode(input) : input;
	return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function concatBytes(...parts: ArrayLike<number>[]): Uint8Array<ArrayBuffer> {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** Compares in time that depends only on length, not on where the inputs differ. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

export function constantTimeEqualStrings(a: string, b: string): boolean {
	return constantTimeEqual(encoder.encode(a), encoder.encode(b));
}

export function randomToken(byteLength = 24): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

/** Verifies GitHub's `X-Hub-Signature-256: sha256=<hex>` header against the raw body. */
export async function verifyWebhookSignature(
	secret: string,
	body: string,
	header: string | null | undefined,
): Promise<boolean> {
	if (!secret || !header?.startsWith("sha256=")) return false;
	const expected = bytesToHex(await hmacSha256(secret, body));
	return constantTimeEqualStrings(expected, header.slice("sha256=".length).toLowerCase());
}

// --- RSA keys and the GitHub App JWT -------------------------------------------------------

function pemBody(pem: string): { label: string; der: Uint8Array } {
	const match = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(pem);
	if (!match) throw new Error("Not a PEM-encoded key");
	return { label: match[1]!, der: base64ToBytes(match[2]!.replace(/\s+/g, "")) };
}

function derLength(length: number): number[] {
	if (length < 0x80) return [length];
	const bytes: number[] = [];
	for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
		bytes.unshift(remaining & 0xff);
	}
	return [0x80 | bytes.length, ...bytes];
}

// AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }
const RSA_ALGORITHM_IDENTIFIER = [
	0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

/**
 * GitHub issues App keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), but WebCrypto only imports PKCS#8.
 * PKCS#8 is a thin wrapper: SEQUENCE { INTEGER 0, AlgorithmIdentifier, OCTET STRING(pkcs1) }.
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
	const version = [0x02, 0x01, 0x00];
	const privateKey = concatBytes([0x04], derLength(pkcs1.length), pkcs1);
	const body = concatBytes(version, RSA_ALGORITHM_IDENTIFIER, privateKey);
	return concatBytes([0x30], derLength(body.length), body);
}

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
	const { label, der } = pemBody(pem);
	let pkcs8: Uint8Array<ArrayBuffer>;
	if (label === "RSA PRIVATE KEY") pkcs8 = pkcs1ToPkcs8(der);
	else if (label === "PRIVATE KEY") pkcs8 = concatBytes(der);
	else throw new Error(`Unsupported PEM type: ${label}`);
	return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function signJwtRs256(payload: Record<string, unknown>, key: CryptoKey): Promise<string> {
	const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = base64UrlEncode(JSON.stringify(payload));
	const signingInput = `${header}.${claims}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
	return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * JWT for authenticating as the App itself. Backdated 60s for clock drift and valid for 9 of
 * the 10 minutes GitHub allows.
 */
export async function createAppJwt(appId: number, key: CryptoKey, nowMs: number): Promise<string> {
	const now = Math.floor(nowMs / 1000);
	return signJwtRs256({ iat: now - 60, exp: now + 540, iss: appId }, key);
}

// --- Encryption at rest ----------------------------------------------------------------------

/** Derives an AES-256-GCM key from an operator-supplied secret of any length. */
export async function deriveEncryptionKey(secret: string): Promise<CryptoKey> {
	if (!secret) throw new Error("ENCRYPTION_KEY is not set");
	const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
	return crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: encoder.encode("cf-actions"), info: encoder.encode("app-credentials-v1") },
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptString(key: CryptoKey, plaintext: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
	return `v1.${bytesToBase64(concatBytes(iv, new Uint8Array(ciphertext)))}`;
}

export async function decryptString(key: CryptoKey, token: string): Promise<string> {
	if (!token.startsWith("v1.")) throw new Error("Unknown ciphertext format");
	const bytes = base64ToBytes(token.slice(3));
	const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
	return decoder.decode(plaintext);
}
